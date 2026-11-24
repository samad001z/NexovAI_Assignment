import { useEffect, useRef, useState } from "react";
import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
} from "@phosphor-icons/react";
import type { useCall } from "../useCall";
import { useAudioLevels } from "../useAudioLevels";
import { Ticket } from "./Console";
import { MicMeter } from "./MicMeter";
import { Ribbons } from "./Ribbons";

type Call = ReturnType<typeof useCall>;

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A phone that pops up on the staff desk: ringing, connected, ended, with the conversation inside it. */
export function PhoneCall({ call, onCallAgain }: { call: Call; onCallAgain: () => void }) {
  const { state, lines, muted, speaker, startedAt, endedAt, tracks, error, receipt } = call;
  const levels = useAudioLevels(tracks.mic, tracks.bot);
  const log = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [lines, receipt]);

  const done = state === "ended" || state === "failed";
  const duration = clock((endedAt ?? now) - (startedAt ?? now));
  const status =
    state === "ringing"
      ? "Calling…"
      : state === "live"
        ? speaker === "agent"
          ? "Speaking"
          : muted
            ? "Muted"
            : speaker === "caller"
              ? "Hearing you"
              : "Listening"
        : state === "ended"
          ? "Call ended"
          : "Couldn't connect";
  const time = new Date(now).toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });

  return (
    <section className={`phone phone--${state}`} aria-label="Call with Asha">
      <div className="phone__screen">
        <div className="phone__bar" aria-hidden>
          <span className="num">{time}</span>
          <span className="phone__island" />
          <span className="phone__signal">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>

        <header className="phone__who">
          <div className="phone__avatar" aria-hidden>
            {(state === "ringing" || speaker === "agent") && <span className="halo" />}
            <div className="orb" />
          </div>
          <h2>Asha</h2>
          <p aria-live="polite">
            {state === "live" && speaker !== "agent" && !muted && <MicMeter levels={levels} active />}
            {status}
            {startedAt && (
              <>
                {" · "}
                <span className="num">{duration}</span>
              </>
            )}
          </p>
        </header>

        <div className="phone__wave">
          <Ribbons levels={levels} speaker={speaker} muted={muted} tone="violet" mode={state === "live" ? "live" : done ? "still" : "idle"} />
        </div>

        <div className="phone__log" ref={log} aria-live="polite" aria-label="Transcript">
          {state === "ringing" && lines.length === 0 && <p className="phone__note">Ringing the front desk…</p>}
          {state === "failed" && <p className="phone__note phone__note--error">{error ?? "The call didn't connect."}</p>}
          {lines.map((l) => (
            <p key={l.id} className={`bubble bubble--${l.who} ${l.final ? "" : "is-live"}`}>
              {l.text}
            </p>
          ))}
          {receipt && <Ticket slip={receipt} />}
        </div>

        <footer className="phone__controls">
          {done ? (
            <>
              <button className="phone__btn" onClick={call.dismiss}>
                Close
              </button>
              <button className="phone__btn phone__btn--call" onClick={onCallAgain}>
                <PhoneIcon size={18} weight="fill" />
                Call again
              </button>
            </>
          ) : (
            <>
              <button
                className={`phone__round ${muted ? "is-on" : ""}`}
                onClick={call.toggleMute}
                disabled={state !== "live"}
                aria-pressed={muted}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? <MicrophoneSlashIcon size={22} /> : <MicrophoneIcon size={22} />}
                <span>{muted ? "Unmute" : "Mute"}</span>
              </button>
              <button className="phone__round phone__round--end" onClick={call.end} aria-label="End call">
                <PhoneDisconnectIcon size={24} weight="fill" />
                <span>End</span>
              </button>
            </>
          )}
        </footer>
        <span className="phone__home" aria-hidden />
      </div>
    </section>
  );
}
