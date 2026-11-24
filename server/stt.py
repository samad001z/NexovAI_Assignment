"""Local Whisper speech-to-text for English, Hindi, Hinglish and Telugu callers.

Runs faster-whisper (large-v3-turbo) on this machine: on the GPU when CUDA works,
otherwise on the CPU. The model is loaded once per server and shared by every call;
Pipecat's own WhisperSTTService would load it again for each call.

Language handling, tuned on test clips:
- Whisper's detector is weak on Telugu: a Telugu sentence scored te 2%, with the
  rest spread over gu/ta/mr/kn. So scores are pooled into families: South Indian
  and nearby scripts count toward Telugu, hi/ur/mr/ne toward Hindi.
- Short replies ("haan", "yes", under 1.5 s) are too short to detect, so each call
  remembers its caller's language and reuses it for them.
- Hinglish is detected as Hindi and written in Devanagari, which the LLM reads fine.
"""

import asyncio
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
from loguru import logger
from pipecat.frames.frames import ErrorFrame, TranscriptionFrame
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

MODEL = os.getenv("WHISPER_MODEL", "deepdml/faster-whisper-large-v3-turbo-ct2")
# Whisper language codes pooled into the three languages the clinic serves.
FAMILIES = {
    "en": {"en"},
    "hi": {"hi", "ur", "mr", "ne", "pa"},
    "te": {"te", "ta", "kn", "ml", "gu", "bn", "si", "or"},
}
# Clip lengths include ~1.3 s of padding (pre-speech audio + the VAD's closing silence).
SHORT_SECS = 3.5  # below this (~2 s of speech), trust the call's language over detection: saves a 0.44 s pass
LEARN_SECS = 2.5  # detection on clips this long is reliable enough to set the call's language
# A few in-language words prime Whisper for short answers ("हाँ" instead of "Huh?").
PROMPTS = {
    "en": "Yes, haan, okay, theek hai. Doctor, appointment, tomorrow.",
    "hi": "हाँ, जी, ठीक है, नहीं, हां बिल्कुल। डॉक्टर, अपॉइंटमेंट, कल, शाम।",
    "te": "అవును, సరే. డాక్టర్, అపాయింట్మెంట్, రేపు, సాయంత్రం.",
}
# Names the clinic actually hears, so Whisper spells them right.
HOTWORDS = "Banyan Clinic, Asha, Ananya Rao, Farhan Siddiqui, Meera Iyer, Vikram Reddy, Sana Qureshi"
NO_SPEECH = 0.5  # drop segments Whisper itself thinks are probably silence or noise


def _add_cuda_dlls() -> None:
    """On Windows, CTranslate2 finds cuBLAS/cuDNN only if their folders are on the DLL path.
    The nvidia-*-cu12 wheels install them under site-packages/nvidia/<lib>/bin."""
    if sys.platform != "win32":
        return
    import site

    for sp in site.getsitepackages():
        for lib in ("cublas", "cudnn", "cuda_nvrtc"):
            d = Path(sp, "nvidia", lib, "bin")
            if d.is_dir():
                os.add_dll_directory(str(d))
                os.environ["PATH"] = f"{d}{os.pathsep}{os.environ.get('PATH', '')}"


_model = None
_model_lock = threading.Lock()
device_used = "not loaded"


def shared_model():
    """Load the Whisper model on first use, then reuse it. Thread-safe."""
    global _model, device_used
    with _model_lock:
        if _model is not None:
            return _model
        _add_cuda_dlls()
        from faster_whisper import WhisperModel

        wanted = os.getenv("WHISPER_DEVICE", "auto")
        attempts = [("cuda", "float16"), ("cpu", "int8")] if wanted == "auto" else [(wanted, "default")]
        for device, compute in attempts:
            try:
                t = time.time()
                model = WhisperModel(MODEL, device=device, compute_type=compute)
                # a throwaway pass: proves the device really works (cuDNN loads lazily) and warms it up
                model.transcribe(np.zeros(16000, dtype=np.float32), language="en")
                _model, device_used = model, f"{device}/{compute}"
                logger.info(f"Whisper {MODEL} ready on {device_used} in {time.time() - t:.1f}s")
                return _model
            except Exception as e:  # noqa: BLE001 - any failure here means "try the next device"
                logger.warning(f"Whisper could not start on {device}: {e}")
        raise RuntimeError("Whisper failed to load on every device")


def preload_in_background() -> None:
    """Start loading at server start, so the first call does not wait for it."""
    threading.Thread(target=shared_model, name="whisper-preload", daemon=True).start()


def pick_language(model, audio: np.ndarray, prior: str | None) -> str:
    """en, hi or te for this utterance. `prior` is the language this caller has been using."""
    if prior and len(audio) < SHORT_SECS * 16000:
        return prior
    _, _, probs = model.detect_language(audio)
    score = {fam: sum(p for code, p in probs if code in codes) for fam, codes in FAMILIES.items()}
    best = max(score, key=score.get)
    # a caller rarely switches language; only switch on a clear margin
    if prior and best != prior and score[best] - score[prior] < 0.2:
        return prior
    return best


def transcribe(audio: np.ndarray, prior: str | None = None) -> tuple[str, str]:
    """Transcribe 16 kHz float32 audio. Returns (text, language code: en, hi or te)."""
    model = shared_model()
    lang = pick_language(model, audio, prior)
    segments, _ = model.transcribe(
        audio,
        language=lang,
        beam_size=5,
        hotwords=HOTWORDS,
        initial_prompt=PROMPTS[lang],
        condition_on_previous_text=False,  # each utterance stands alone; stops runaway repeats
        without_timestamps=True,  # we only need the text; also stops short clips looping (1.4 s -> 0.5 s)
    )
    text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < NO_SPEECH).strip()
    return text, lang


class ClinicWhisperSTT(WhisperSTTService):
    """Pipecat STT service backed by the shared model and the restricted language detection."""

    def _load(self):  # called by WhisperSTTService.__init__; reuse instead of loading again
        self._model = shared_model()
        self._caller_lang: str | None = None  # remembered for this call

    async def run_stt(self, audio: bytes):
        if not self._model:
            yield ErrorFrame("Whisper model not available")
            return
        await self.start_processing_metrics()
        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        text, lang = await asyncio.to_thread(transcribe, samples, self._caller_lang)
        await self.stop_processing_metrics()
        if text and len(samples) >= LEARN_SECS * 16000:
            self._caller_lang = lang
        if text:
            logger.debug(f"Whisper [{lang}] {len(samples) / 16000:.1f}s audio: {text}")
            # One transcript per utterance, so it is final: the turn can end the moment it lands.
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), Language(lang), finalized=True)


if __name__ == "__main__":
    # Self-check on raw 16 kHz PCM clips: python stt.py clip1.pcm clip2.pcm ...
    shared_model()
    print("device:", device_used)
    # each argument is one simulated call: comma-separated clips, spoken in order
    for call in sys.argv[1:]:
        prior = None
        for path in call.split(","):
            pcm = np.fromfile(path, dtype=np.int16).astype(np.float32) / 32768.0
            t = time.time()
            text, lang = transcribe(pcm, prior)
            if len(pcm) >= LEARN_SECS * 16000:
                prior = lang
            print(f"{Path(path).stem:10s} {len(pcm) / 16000:4.1f}s audio -> {time.time() - t:4.2f}s [{lang}] {text}")
        print("-")
