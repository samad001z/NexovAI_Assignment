import { useEffect, useRef } from "react";

export type Levels = { mic: number; bot: number };

/**
 * Live loudness (0..1, smoothed) of the caller's mic and Asha's voice.
 * Written to a ref on every animation frame, so readers (canvas loops) never
 * cause a React render. One AudioContext per call.
 */
export function useAudioLevels(mic?: MediaStreamTrack, bot?: MediaStreamTrack) {
  const levels = useRef<Levels>({ mic: 0, bot: 0 });

  useEffect(() => {
    if (!mic && !bot) return;
    const ac = new AudioContext();
    const tap = (track?: MediaStreamTrack) => {
      if (!track) return null;
      const node = ac.createAnalyser();
      node.fftSize = 512;
      ac.createMediaStreamSource(new MediaStream([track])).connect(node);
      return node;
    };
    const taps = { mic: tap(mic), bot: tap(bot) };
    const buf = new Float32Array(512);
    const rms = (node: AnalyserNode | null) => {
      if (!node) return 0;
      node.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      return Math.min(1, Math.sqrt(s / buf.length) * 7);
    };

    let raf = 0;
    const tick = () => {
      const l = levels.current;
      for (const k of ["mic", "bot"] as const) {
        const target = rms(taps[k]);
        // fast attack, slow release: reads as a voice, not as flicker
        l[k] += (target - l[k]) * (target > l[k] ? 0.35 : 0.08);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      levels.current = { mic: 0, bot: 0 };
      void ac.close();
    };
  }, [mic, bot]);

  return levels;
}
