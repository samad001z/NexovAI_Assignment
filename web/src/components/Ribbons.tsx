import { useEffect, useRef, type RefObject } from "react";
import type { Levels } from "../useAudioLevels";
import type { Speaker } from "../useCall";

type Props = {
  levels: RefObject<Levels>;
  speaker: Speaker;
  muted: boolean;
  /** "idle" breathes slowly while the call connects; "live" follows the voices. */
  mode: "idle" | "live" | "still";
  /** saffron on the patient page, violet on the staff desk */
  tone?: "saffron" | "violet";
};

// Silk ribbons crossing a light beam, with a soft reflection underneath.
// Each ribbon is many thin strands; additive blending turns the overlaps into glow.
// Asha's ribbons follow her voice (saffron or violet), the caller's follow theirs (periwinkle or cyan).
const RIBBONS = [
  { rgb: "255 122 46", k: 1.15, speed: 0.55, phase: 0.0, center: 0.4, spread: 0.26, who: "agent" },
  { rgb: "169 180 255", k: 0.95, speed: -0.45, phase: 2.1, center: 0.58, spread: 0.26, who: "caller" },
  { rgb: "255 176 96", k: 1.6, speed: 0.75, phase: 4.2, center: 0.5, spread: 0.2, who: "agent" },
  { rgb: "214 220 255", k: 1.35, speed: 0.6, phase: 1.3, center: 0.66, spread: 0.18, who: "caller" },
] as const;
const VIOLET = ["192 92 255", "64 214 255", "108 92 255", "64 230 220"];
const BEAMS = {
  saffron: ["255 122 46", "255 140 60", "255 236 214", "169 180 255"],
  violet: ["192 92 255", "200 110 255", "120 230 255", "64 214 255"],
};
const STRANDS = 14;
const STEP = 4; // px between path points

export function Ribbons({ levels, speaker, muted, mode, tone = "saffron" }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ speaker, muted, mode });
  live.current = { speaker, muted, mode };

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d")!;
    const off = document.createElement("canvas");
    const o = off.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const energy = { agent: 0, caller: 0 };
    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) {
        raf = requestAnimationFrame(draw);
        return;
      }
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = off.width = Math.round(w * dpr);
        el.height = off.height = Math.round(h * dpr);
      }

      const { muted: isMuted, mode: m } = live.current;
      const lv = levels.current ?? { mic: 0, bot: 0 };
      const t = still ? 1.2 : (now - t0) / 1000;
      const breathe = m === "idle" ? 0.18 + 0.08 * Math.sin(t * 2.2) : 0.12;
      const target = {
        agent: m === "live" ? lv.bot : 0,
        caller: m === "live" && !isMuted ? lv.mic : 0,
      };
      energy.agent += (target.agent - energy.agent) * 0.12;
      energy.caller += (target.caller - energy.caller) * 0.12;

      const mid = h * 0.5;

      // 1. ribbons into the offscreen layer
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      o.clearRect(0, 0, w, h);
      o.globalCompositeOperation = "lighter";
      o.lineWidth = 1;
      for (const [i, r] of RIBBONS.entries()) {
        const rgb = tone === "violet" ? VIOLET[i] : r.rgb;
        const e = breathe + energy[r.who] * 1.1;
        const amp = h * (0.07 + Math.min(1, e) * 0.3);
        const width = h * (0.03 + Math.min(1, e) * 0.09);
        const alpha = 0.1 + Math.min(1, e) * 0.14;
        for (let s = 0; s < STRANDS; s++) {
          const off01 = s / (STRANDS - 1) - 0.5;
          o.strokeStyle = `rgb(${rgb} / ${alpha * (1 - Math.abs(off01))})`;
          o.beginPath();
          for (let x = 0; x <= w + STEP; x += STEP) {
            const u = x / w;
            const env = Math.exp(-(((u - r.center) / r.spread) ** 2)); // bump in the middle, flat at the edges
            const wave = Math.sin(u * Math.PI * 2 * r.k + t * r.speed + r.phase);
            const twist = Math.cos(u * Math.PI * 2 * r.k * 0.55 + t * r.speed * 0.8 + r.phase);
            const y = mid - env * (amp * wave + width * off01 * twist * 2);
            if (x === 0) o.moveTo(x, y);
            else o.lineTo(x, y);
          }
          o.stroke();
        }
      }

      // 2. the beam
      const beam = o.createLinearGradient(0, 0, w, 0);
      const [b0, b1, b2, b3] = BEAMS[tone];
      beam.addColorStop(0, `rgb(${b0} / 0)`);
      beam.addColorStop(0.2, `rgb(${b1} / 0.9)`);
      beam.addColorStop(0.5, `rgb(${b2} / 1)`);
      beam.addColorStop(0.8, `rgb(${b3} / 0.9)`);
      beam.addColorStop(1, `rgb(${b3} / 0)`);
      o.strokeStyle = beam;
      o.globalAlpha = 0.25;
      o.lineWidth = 6;
      o.beginPath();
      o.moveTo(0, mid);
      o.lineTo(w, mid);
      o.stroke();
      o.globalAlpha = 1;
      o.lineWidth = 1.4;
      o.stroke();
      o.globalCompositeOperation = "source-over";

      // 3. composite: ribbons above the beam, a dimmed mirror below it
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, el.width, el.height);
      g.drawImage(off, 0, 0);
      g.save();
      g.globalAlpha = 0.28;
      g.filter = "blur(5px)";
      g.translate(0, mid * dpr * 2);
      g.scale(1, -1);
      g.drawImage(off, 0, 0, off.width, mid * dpr, 0, 0, off.width, mid * dpr);
      g.restore();
      // fade everything below the beam into the floor
      const fade = g.createLinearGradient(0, mid * dpr, 0, el.height);
      fade.addColorStop(0, "rgb(0 0 0 / 0)");
      fade.addColorStop(1, "rgb(0 0 0 / 1)");
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = fade;
      g.fillRect(0, mid * dpr + 2, el.width, el.height);
      g.globalCompositeOperation = "source-over";

      if (!still) raf = requestAnimationFrame(draw); // reduced motion: one static frame
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [levels, tone]);

  return <canvas ref={canvas} className="ribbons" aria-hidden />;
}
