import { useEffect, useRef, type RefObject } from "react";
import type { Levels } from "../useAudioLevels";

const WEIGHTS = [0.55, 0.85, 1, 0.8, 0.6];

/** Five bars that move with the caller's voice, so they can see Asha is hearing them. */
export function MicMeter({ levels, active }: { levels: RefObject<Levels>; active: boolean }) {
  const el = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const bars = [...(el.current?.children ?? [])] as HTMLElement[];
    let raf = 0;
    const tick = (t: number) => {
      const lv = active ? Math.min(1, (levels.current?.mic ?? 0) * 1.8) : 0;
      bars.forEach((b, i) => {
        const wobble = 0.75 + 0.25 * Math.sin(t / 95 + i * 1.7); // neighbours move a little differently
        b.style.transform = `scaleY(${0.2 + lv * WEIGHTS[i] * wobble * 0.8})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levels, active]);

  return (
    <span className="meter" ref={el} aria-hidden>
      {WEIGHTS.map((_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
