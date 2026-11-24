// Call sounds made with Web Audio, so there are no audio files to ship.
// Ringback follows the Indian pattern: 400+450 Hz, 0.4s on, 0.2s off, 0.4s on, 2s off.

let ctx: AudioContext | null = null;
const audio = () => (ctx ??= new AudioContext());

function tone(freqs: number[], start: number, dur: number, gain = 0.06) {
  const a = audio();
  const g = a.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.02);
  g.gain.setValueAtTime(gain, start + dur - 0.03);
  g.gain.linearRampToValueAtTime(0, start + dur);
  g.connect(a.destination);
  for (const f of freqs) {
    const o = a.createOscillator();
    o.frequency.value = f;
    o.connect(g);
    o.start(start);
    o.stop(start + dur);
  }
}

export function startRingback(): () => void {
  let stopped = false;
  const cycle = () => {
    if (stopped) return;
    const t = audio().currentTime + 0.05;
    tone([400, 450], t, 0.4);
    tone([400, 450], t + 0.6, 0.4);
  };
  cycle();
  const id = window.setInterval(cycle, 3000);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}

export function playHangup() {
  const t = audio().currentTime + 0.02;
  for (let i = 0; i < 3; i++) tone([480, 620], t + i * 0.28, 0.16, 0.05);
}

export function playChime() {
  const t = audio().currentTime + 0.02;
  tone([660], t, 0.12, 0.04);
  tone([990], t + 0.12, 0.22, 0.04);
}
