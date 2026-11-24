"""The voice pipeline.

Browser mic --WebRTC--> VAD + ElevenLabs STT --> Gemini (with tools) --> ElevenLabs TTS --WebRTC--> browser speaker
"""

import asyncio
import os

import aiohttp

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import BotStartedSpeakingFrame, BotStoppedSpeakingFrame, TTSSpeakFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService, ElevenLabsSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from google.genai.types import HttpOptions, HttpRetryOptions
from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.services.google.llm import GoogleLLMService
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

import events
import tools
from prompt import GREETING, system_prompt


class QuietVADUserTurnStartStrategy(VADUserTurnStartStrategy):
    """VAD starts the caller's turn, but only while Asha is quiet.

    While she speaks, MinWordsUserTurnStartStrategy decides instead (3 words), so a cough or a
    click no longer cuts her off. VAD stays in charge the rest of the time because a turn started
    from a transcript loses a VAD stop that came first: a short "Yes" would then wait out
    Pipecat's 5 s stop timeout.
    """

    _bot_speaking = False

    async def process_frame(self, frame):
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif not self._bot_speaking:
            await super().process_frame(frame)


class HedgedGoogleLLMService(GoogleLLMService):
    """Gemini, with a backup request to a second model when the first is slow.

    Flash-Lite usually starts answering in about a second, but at busy times a single
    request stalls for 5-20 s while the next one is fast again. If nothing has arrived
    after HEDGE_SECS, the same request goes to BACKUP_MODEL, and whichever reply starts
    first is used. The backup is another Flash-Lite route: gemini-3-flash-preview was
    faster on paper but its free quota ran out mid-demo (every request 429).
    """

    HEDGE_SECS = 1.0  # healthy Flash-Lite answers in ~1.1 s
    GIVE_UP_SECS = 15.0
    BACKUP_MODEL = os.getenv("GEMINI_BACKUP_MODEL", "gemini-flash-lite-latest")

    async def _first_chunk(self, context, model: str | None):
        """Send the request and wait for its first chunk. Returns (stream, first chunk or None)."""
        if model:
            primary = self._settings.model
            self._settings.model = model  # _stream_content reads the model before its first await returns
            try:
                stream = await self._stream_content(context)
            finally:
                self._settings.model = primary
        else:
            stream = await self._stream_content(context)
        try:
            return stream, await anext(stream)  # the request goes out on the first pull
        except StopAsyncIteration:
            return stream, None

    async def _stream_response(self, context):
        tools.pin_language(context.messages)
        loop = asyncio.get_running_loop()
        give_up = loop.time() + self.HEDGE_SECS + self.GIVE_UP_SECS
        tasks = [asyncio.create_task(self._first_chunk(context, None))]
        hedged, error, result = False, None, None
        try:
            while result is None:
                pending = [t for t in tasks if not t.done()]
                wait = self.HEDGE_SECS if not hedged else give_up - loop.time()
                if pending and wait > 0:
                    done, _ = await asyncio.wait(pending, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
                    for t in done:
                        if t.exception():
                            error = error or t.exception()  # e.g. a 429; the other request may still win
                        else:
                            result = t.result()
                            break
                if result is not None:
                    break
                if not hedged:  # primary is slow, or failed outright
                    hedged = True
                    logger.info(f"{self}: no reply after {self.HEDGE_SECS}s, also asking {self.BACKUP_MODEL}")
                    tasks.append(asyncio.create_task(self._first_chunk(context, self.BACKUP_MODEL)))
                elif all(t.done() for t in tasks):
                    raise error
                elif loop.time() >= give_up:
                    raise TimeoutError(f"{self}: no reply from Gemini in {self.HEDGE_SECS + self.GIVE_UP_SECS:.0f}s")
        finally:
            for t in tasks:
                t.cancel()
        stream, first = result
        if first is None:
            return
        yield first
        async for chunk in stream:
            yield chunk

# Asha's voice: ElevenLabs "Tara", a natural Indian-English female voice that also
# speaks Hindi well. Chosen by the clinic. One voice for every caller,
# so the clinic always sounds the same. Override with ELEVENLABS_VOICE_ID.
ASHA_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "8qPG2eSETnKl5ezq52Js")
DEFAULT_MODEL = "gemini-3.5-flash-lite"
STT_ENGINE = os.getenv("STT_ENGINE", "elevenlabs")
SORRY = "Sorry, I didn't quite get that. Could you say it once more?"


async def run_bot(connection: SmallWebRTCConnection) -> None:
    try:
        async with aiohttp.ClientSession() as http:
            await _run(connection, http)
    except Exception:
        # Without this the browser waits forever for a bot that already died.
        logger.exception("Call pipeline crashed")
        await connection.disconnect()


async def _run(connection: SmallWebRTCConnection, http: aiohttp.ClientSession) -> None:
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )

    # Speech to text. Default: ElevenLabs Scribe v2 Realtime with automatic language
    # detection: English, Hindi, Hinglish (English words stay in English letters) and
    # Telugu, final transcript ~0.3 s after the caller stops. STT_ENGINE=whisper runs a
    # local Whisper on this machine's GPU instead (see stt.py): no STT cost, ~1 s slower.
    keyterms = ["Banyan", "Ananya Rao", "Farhan Siddiqui", "Meera Iyer", "Vikram Reddy", "Sana Qureshi"]
    whisper = STT_ENGINE == "whisper"
    if whisper:
        import stt as whisper_stt  # optional: needs requirements-whisper.txt

        # Whisper transcribes each utterance after the caller pauses: about 0.5-1.3 s on
        # an RTX 3050. Telling Pipecat that keeps it waiting for the words before replying.
        await asyncio.to_thread(whisper_stt.shared_model)  # waits off the event loop if still loading
        stt = whisper_stt.ClinicWhisperSTT(settings=whisper_stt.ClinicWhisperSTT.Settings(model=whisper_stt.MODEL), ttfs_p99_latency=1.6)
    elif os.getenv("ELEVENLABS_STT_MODE", "realtime") == "batch":
        # Fallback: VAD cuts each utterance, then the whole clip goes to Scribe v2 over HTTP.
        stt = ElevenLabsSTTService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            aiohttp_session=http,
            settings=ElevenLabsSTTService.Settings(language=None, keyterms=keyterms),  # None: auto-detect
        )
    else:
        # Default: stream audio over a websocket to Scribe v2 Realtime. Commit strategy is
        # MANUAL, so Pipecat's VAD decides when the caller stopped talking.
        stt = ElevenLabsRealtimeSTTService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            settings=ElevenLabsRealtimeSTTService.Settings(language=None, keyterms=keyterms),  # None: auto-detect
        )

    # Flash-Lite: answers in about a second. The bigger Flash models measured 4-18 s
    # per turn on this key and return 503 "high demand" at peak times.
    llm_settings = GoogleLLMService.Settings(
        system_instruction=system_prompt(),
        temperature=0.3,
        model=os.getenv("GEMINI_MODEL", DEFAULT_MODEL),
    )
    llm = HedgedGoogleLLMService(
        api_key=os.environ["GOOGLE_API_KEY"],
        settings=llm_settings,
        # Retry overload and server errors quietly instead of dropping the caller's turn.
        # Stalls (no error, just no first token) are handled by the hedge above; the SDK
        # can't retry those on its aiohttp path, and Google rejects deadlines under 10 s.
        http_options=HttpOptions(
            timeout=12_000,  # ms per attempt
            retry_options=HttpRetryOptions(
                attempts=3, initial_delay=0.4, max_delay=2.0, http_status_codes=[429, 500, 503, 504]
            ),
        ),
    )
    tools.register(llm)

    tts = ElevenLabsTTSService(
        api_key=os.environ["ELEVENLABS_API_KEY"],
        settings=ElevenLabsTTSService.Settings(
            voice=ASHA_VOICE_ID,
            model=os.getenv("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5"),
        ),
    )

    # Conversation memory shared by the user and assistant aggregators.
    context = LLMContext(tools=tools.TOOLS)
    aggregators = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            # Silero VAD: detects when the caller starts and stops speaking,
            # which drives interruptions and end of turn.
            # 0.2 s is Pipecat's recommended value with its turn analyzer; 0.5 s added
            # about 3 s of waiting after the caller stopped talking.
            # With Whisper each pause also ends a transcription segment, so pause a little
            # longer (0.4 s) to keep a sentence in one piece instead of fragments.
            # 0.3 s (not Pipecat's 0.2) for Scribe: callers pause briefly inside phone numbers, and
            # a 0.2 s stop made Scribe finalize mid-word and repeat a digit (98480-2 + 22137).
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.4 if whisper else 0.3)),
            # Smart Turn decides whether the caller has finished. When it judges a short
            # reply ("Yes.", "Ha.") unfinished, it waits for silence: 3 s by default,
            # which callers hear as Asha being slow. 1.2 s of silence is a clear enough stop.
            # Pipecat's default lets any sound the VAD hears (a cough, a click, "hmm") cut Asha
            # off mid-sentence. While she speaks, it now takes 3 transcribed words to interrupt
            # her; while she is quiet, VAD starts the caller's turn at once, as before.
            # Whisper sends no interim words, so it keeps the default.
            user_turn_strategies=UserTurnStrategies(
                start=None if whisper else [QuietVADUserTurnStartStrategy(), MinWordsUserTurnStartStrategy(min_words=3)],
                stop=[TurnAnalyzerUserTurnStopStrategy(
                    turn_analyzer=LocalSmartTurnAnalyzerV3(params=SmartTurnParams(stop_secs=1.2))
                )]
            ),
        ),
    )

    pipeline = Pipeline([
        transport.input(),
        stt,
        aggregators.user(),
        llm,
        tts,
        transport.output(),
        aggregators.assistant(),
    ])

    # RTVI is on by default: it streams transcripts and speaking events to the browser.
    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    live = {"on": False}  # is this call counted as active on the staff desk?

    @transport.event_handler("on_client_connected")
    async def on_connected(transport, client):
        logger.info("Caller connected")
        if not live["on"]:
            live["on"] = True
            events.call_started()

    # The browser says it is ready once its audio is wired up. Answer right then
    # with a fixed greeting: no LLM round trip, and no clipped first word.
    @task.rtvi.event_handler("on_client_ready")
    async def on_ready(rtvi):
        await task.queue_frames([TTSSpeakFrame(GREETING)])

    # If the model still fails after its retries, say so instead of going silent.
    @task.event_handler("on_pipeline_error")
    async def on_error(task_, frame):
        if frame.processor is llm:
            logger.warning(f"LLM error, apologising to caller: {frame.error}")
            await task.queue_frames([TTSSpeakFrame(SORRY, append_to_context=False)])

    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport, client):
        logger.info("Caller hung up")
        await task.cancel()

    try:
        await PipelineRunner(handle_sigint=False).run(task)
    finally:
        # however the call ends (hang-up, end_call, crash), count it as over exactly once
        if live["on"]:
            live["on"] = False
            events.call_ended()
