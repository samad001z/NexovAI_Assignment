import { useCallback, useEffect, useRef, useState } from "react";
import { PipecatClient, type BotOutputData, type TranscriptData } from "@pipecat-ai/client-js";
import { SmallWebRTCTransport } from "@pipecat-ai/small-webrtc-transport";
import type { Appointment } from "./api";
import { playChime, playHangup, startRingback } from "./sounds";

/** This caller's own booking or cancellation, sent privately over the call. */
export type Receipt = { kind: "booked" | "cancelled"; appt: Appointment };

export type CallState = "idle" | "ringing" | "live" | "ended" | "failed";
export type Line = { id: number; who: "caller" | "agent"; text: string; final: boolean };
export type Speaker = "caller" | "agent" | null;

const MIN_RING_MS = 1200; // one ring, like a real call, then Asha answers
const ANSWER_TIMEOUT_MS = 15000; // give up if the agent never says it is ready

// The transport hands us Asha's audio track but does not play it; this element does.
// Created on demand and reused, so it is unlocked by the click that starts the call.
let speakerEl: HTMLAudioElement | null = null;
function playRemote(track: MediaStreamTrack | null) {
  if (!speakerEl) {
    speakerEl = Object.assign(new Audio(), { autoplay: true, hidden: true, id: "asha-audio" });
    document.body.append(speakerEl); // in the DOM so it shows up in devtools
  }
  speakerEl.srcObject = track ? new MediaStream([track]) : null;
  if (track) void speakerEl.play().catch((e) => console.warn("Could not play Asha's audio:", e));
}

export function useCall() {
  const [state, setState] = useState<CallState>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState<Speaker>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [tracks, setTracks] = useState<{ mic?: MediaStreamTrack; bot?: MediaStreamTrack }>({});
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const client = useRef<PipecatClient | null>(null);
  const nextId = useRef(1);
  const agentOpen = useRef(false); // is the last agent line still being spoken?
  const sawWords = useRef(false);
  const segments = useRef(new Map<number, string>()); // the agent's current turn, by segment
  const stopRing = useRef<() => void>(() => {});
  const over = useRef(false); // finish() runs once per call

  const pushOrUpdate = useCallback((who: Line["who"], text: string, final: boolean, append: boolean) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      const extend = last && last.who === who && !last.final;
      if (extend) {
        const updated = { ...last, text: append ? `${last.text} ${text}`.trim() : text, final };
        return [...prev.slice(0, -1), updated];
      }
      return [...prev, { id: nextId.current++, who, text, final }];
    });
  }, []);

  const closeAgentLine = useCallback(() => {
    agentOpen.current = false;
    sawWords.current = false;
    segments.current.clear();
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last?.who === "agent" && !last.final) return [...prev.slice(0, -1), { ...last, final: true }];
      return prev;
    });
  }, []);

  const finish = useCallback((failed?: string) => {
    if (over.current) return;
    over.current = true;
    stopRing.current();
    playRemote(null);
    client.current = null;
    setSpeaker(null);
    setEndedAt(Date.now());
    if (failed) {
      setError(failed);
      setState("failed");
    } else {
      setState((s) => (s === "idle" ? s : "ended"));
      playHangup();
    }
  }, []);

  const start = useCallback(async () => {
    over.current = false;
    segments.current.clear();
    agentOpen.current = false;
    sawWords.current = false;
    setLines([]);
    setError(null);
    setReceipt(null);
    setMuted(false);
    setStartedAt(null);
    setEndedAt(null);
    setTracks({});
    setState("ringing");
    // unlock audio playback inside the click, before any await
    playRemote(null);
    void speakerEl?.play().catch(() => {});
    stopRing.current = startRingback();
    const ringUntil = Date.now() + MIN_RING_MS;

    const pc = new PipecatClient({
      transport: new SmallWebRTCTransport(),
      enableMic: true,
      enableCam: false,
      callbacks: {
        onTrackStarted: (track, participant) => {
          if (track.kind !== "audio") return;
          if (participant?.local) {
            setTracks((t) => ({ ...t, mic: track }));
          } else {
            playRemote(track);
            setTracks((t) => ({ ...t, bot: track }));
          }
        },
        onUserStartedSpeaking: () => setSpeaker("caller"),
        onUserStoppedSpeaking: () => setSpeaker((s) => (s === "caller" ? null : s)),
        onBotStartedSpeaking: () => setSpeaker("agent"),
        onBotStoppedSpeaking: () => {
          setSpeaker((s) => (s === "agent" ? null : s));
          closeAgentLine();
        },
        onUserTranscript: (d: TranscriptData) => {
          if (agentOpen.current) closeAgentLine();
          if (d.text.trim()) pushOrUpdate("caller", d.text, d.final, false);
        },
        onBotOutput: (d: BotOutputData) => {
          if (d.will_be_spoken === false) return;
          // RTVI 2.x: each sentence is one segment, re-sent as it is spoken
          // ("new", then "in-progress" with the words said so far, then "completed").
          // Replace the segment's text each time; appending would repeat the sentence.
          if (d.spoken_status) {
            const said = d.spoken_status === "completed" ? d.text : (d.spoken_progress?.accumulated_text ?? "");
            segments.current.set(d.segment_id ?? -1, said);
            const text = [...segments.current.values()].join(" ").trim();
            if (!text) return;
            agentOpen.current = true;
            pushOrUpdate("agent", text, false, false);
            return;
          }
          // Older servers: word events as they are spoken, sentences as the fallback.
          const kind = d.output_type ?? d.aggregated_by;
          if (kind === "word") {
            sawWords.current = true;
          } else if (kind !== "sentence" || sawWords.current) {
            return;
          }
          agentOpen.current = true;
          pushOrUpdate("agent", d.text, false, true);
        },
        onServerMessage: (m: { type?: string; appointment?: Appointment }) => {
          if ((m?.type === "booked" || m?.type === "cancelled") && m.appointment) {
            setReceipt({ kind: m.type, appt: m.appointment });
            if (m.type === "booked") playChime();
          }
        },
        onDisconnected: () => finish(),
      },
    });
    client.current = pc;

    try {
      // connect() resolves only when the server pipeline reports it is ready.
      // If the pipeline dies first it never resolves, so race it against a timeout.
      let timer = 0;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("timeout")), ANSWER_TIMEOUT_MS);
      });
      try {
        await Promise.race([
          pc.connect({ webrtcRequestParams: { endpoint: "/api/offer" } }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
      const wait = ringUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      stopRing.current();
      if (client.current !== pc) return; // hung up while ringing
      setStartedAt(Date.now());
      setState("live");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (client.current !== pc) return; // hung up while ringing
      finish(
        /permission|NotAllowed/i.test(msg)
          ? "Microphone access is blocked. Allow it in the address bar, then call again."
          : msg === "timeout"
            ? "Asha didn't pick up. Check the server terminal for errors, then call again."
            : "Couldn't reach the front desk. Is the server running on port 7860?",
      );
      void pc.disconnect().catch(() => {});
    }
  }, [closeAgentLine, finish, pushOrUpdate]);

  const end = useCallback(async () => {
    const pc = client.current;
    client.current = null;
    if (pc) await pc.disconnect().catch(() => {});
    finish();
  }, [finish]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      client.current?.enableMic(m);
      return !m;
    });
  }, []);

  const dismiss = useCallback(() => setState("idle"), []);

  useEffect(() => () => void client.current?.disconnect(), []);

  return { state, lines, muted, speaker, startedAt, endedAt, tracks, error, receipt, start, end, toggleMute, dismiss };
}
