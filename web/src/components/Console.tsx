import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { animate, stagger, utils } from "animejs";
import {
  CalendarCheckIcon,
  CalendarXIcon,
  ClockCounterClockwiseIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  XIcon,
} from "@phosphor-icons/react";
import { fmtDay, fmtTime } from "../api";
import type { Receipt, useCall } from "../useCall";
import { useAudioLevels } from "../useAudioLevels";
import { Ribbons } from "./Ribbons";

type Call = ReturnType<typeof useCall>;
type Lang = "en" | "hi" | "te";

const LANGS: { key: Lang; label: string }[] = [
  { key: "en", label: "English" },
  { key: "hi", label: "हिन्दी" },
  { key: "te", label: "తెలుగు" },
];

const INTENTS = [
  {
    icon: CalendarCheckIcon,
    label: "Book",
    en: "I need a skin doctor tomorrow evening.",
    hi: "मुझे कल शाम स्किन डॉक्टर से मिलना है।",
    te: "నాకు రేపు సాయంత్రం చర్మ వైద్యుడి అపాయింట్‌మెంట్ కావాలి.",
  },
  {
    icon: ClockCounterClockwiseIcon,
    label: "Check",
    en: "When is my appointment?",
    hi: "मेरा अपॉइंटमेंट कब है?",
    te: "నా అపాయింట్‌మెంట్ ఎప్పుడు ఉంది?",
  },
  {
    icon: CalendarXIcon,
    label: "Cancel",
    en: "Please cancel my appointment.",
    hi: "मेरा अपॉइंटमेंट कैंसल कर दीजिए।",
    te: "నా అపాయింట్‌మెంట్ రద్దు చేయండి.",
  },
];

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The patient's call console: what to say before the call, the live conversation during it. */
export function Console({ call, onCall, disabled }: { call: Call; onCall: () => void; disabled: boolean }) {
  const { state, lines, muted, speaker, startedAt, endedAt, tracks, error, receipt } = call;
  const [lang, setLang] = useState<Lang>("en");
  const now = useNow(state === "live");
  const levels = useAudioLevels(tracks.mic, tracks.bot);
  const panel = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const inCall = state !== "idle";

  // The panel's contents rise in, top to bottom, whenever it swaps between "before" and "during".
  useLayoutEffect(() => {
    if (!panel.current || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const parts = panel.current.querySelectorAll("[data-enter]");
    utils.set(parts, { opacity: 0, translateY: 12 });
    const a = animate(parts, { opacity: 1, translateY: 0, duration: 650, delay: stagger(55), ease: "outExpo" });
    return () => void a.revert();
  }, [inCall]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [lines, receipt]);

  const done = state === "ended" || state === "failed";
  const duration = startedAt ? clock((endedAt ?? now) - startedAt) : "0:00";
  const title =
    state === "ringing"
      ? "Calling Asha…"
      : state === "failed"
        ? "Call didn't connect"
        : state === "ended"
          ? "Call ended"
          : speaker === "agent"
            ? "Asha is speaking…"
            : "I'm listening…";
  const sub =
    state === "ringing"
      ? "Connecting you to the Banyan Clinic front desk."
      : state === "live"
        ? "Speak naturally, in English, Hindi or Telugu."
        : state === "ended"
          ? `You talked for ${duration}.`
          : (error ?? "Something went wrong.");
  const callerSpoke = lines.some((l) => l.who === "caller");

  return (
    <section className={`console console--${state}`} aria-label="Call Asha">
      <div className="console__panel" ref={panel} key={inCall ? "call" : "idle"}>
        {!inCall ? (
          <>
            <p className="console__status" data-enter>
              <i aria-hidden />
              Online now · answers in seconds
            </p>
            <h2 data-enter>Talk to Asha</h2>
            <p className="console__lede" data-enter>
              Tell her what you need. She checks each doctor's diary, books your slot and gives you a token, all on one
              call.
            </p>
            <div className="langs" role="group" aria-label="Show examples in" data-enter>
              {LANGS.map((l) => (
                <button key={l.key} lang={l.key} aria-pressed={lang === l.key} onClick={() => setLang(l.key)}>
                  {l.label}
                </button>
              ))}
            </div>
            <ul className="intents" data-enter>
              {INTENTS.map((it) => (
                <li key={it.label}>
                  <it.icon size={18} aria-hidden />
                  <span lang={lang}>“{it[lang]}”</span>
                  <small>{it.label}</small>
                </li>
              ))}
            </ul>
            <p className="console__fine" data-enter>
              {lang === "te"
                ? "Asha understands Telugu and replies in English."
                : "Say it in your own words. There are no menus to press."}
            </p>
            <div className="console__cta" data-enter>
              <button className="pill pill--saffron" onClick={onCall} disabled={disabled}>
                <PhoneIcon size={18} weight="fill" />
                Call Asha
              </button>
              <span>Free call from your browser. Uses your microphone.</span>
            </div>
          </>
        ) : (
          <>
            <div className="console__top" data-enter>
              <span className={`status status--${state}`}>
                <i aria-hidden />
                {state === "ringing" ? (
                  "Connecting"
                ) : state === "live" ? (
                  <>
                    Live <span className="num">{duration}</span>
                  </>
                ) : state === "ended" ? (
                  "Call ended"
                ) : (
                  "Not connected"
                )}
              </span>
              {!done && (
                <button className="iconbtn" onClick={call.end} aria-label="End call">
                  <XIcon size={16} weight="bold" />
                </button>
              )}
            </div>

            <div className="console__head" data-enter>
              <h2 aria-live="polite">{title}</h2>
              <p className={state === "failed" ? "is-error" : undefined}>{sub}</p>
            </div>

            <div className="log" ref={log} aria-live="polite" aria-label="Transcript" data-enter>
              {lines.length === 0 && state === "ringing" && <p className="log__note">Asha will answer in a moment.</p>}
              {lines.map((l) => (
                <p key={l.id} className={`line line--${l.who} ${l.final ? "" : "is-live"}`}>
                  <span className="line__who">{l.who === "agent" ? "Asha" : "You"}</span>
                  {l.text}
                </p>
              ))}
              {state === "live" && !callerSpoke && (
                <p className="log__note" lang={lang}>
                  Try: “{INTENTS[0][lang]}”
                </p>
              )}
              {receipt && <Ticket slip={receipt} />}
            </div>

            <div className="console__controls" data-enter>
              {done ? (
                <>
                  <button className="pill pill--night" onClick={call.dismiss}>
                    Close
                  </button>
                  <button className="pill pill--saffron" onClick={onCall}>
                    <PhoneIcon size={18} weight="fill" />
                    Call again
                  </button>
                </>
              ) : (
                <>
                  <button
                    className={`round ${muted ? "is-on" : ""}`}
                    onClick={call.toggleMute}
                    disabled={state !== "live"}
                    aria-pressed={muted}
                    aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  >
                    {muted ? <MicrophoneSlashIcon size={20} /> : <MicrophoneIcon size={20} />}
                  </button>
                  <button className="pill pill--end" onClick={call.end}>
                    <PhoneDisconnectIcon size={18} weight="fill" />
                    End call
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="console__visual">
        <Ribbons levels={levels} speaker={speaker} muted={muted} mode={state === "live" ? "live" : done ? "still" : "idle"} />
        <div className="console__id">
          <span className="sun" aria-hidden />
          <span>
            <b>Asha</b>
            <small>Receptionist, Banyan Clinic</small>
          </span>
        </div>
        {state === "live" && (
          <span className={`console__speaker ${speaker === "agent" ? "is-agent" : ""}`}>
            {speaker === "agent" ? "Asha speaking" : muted ? "You're muted" : "Listening"}
          </span>
        )}
      </div>
    </section>
  );
}

export function Ticket({ slip }: { slip: Receipt }) {
  const { appt, kind } = slip;
  return (
    <div key={appt.id + kind} className={`ticket ticket--${kind}`} role="status">
      <div className="ticket__stub">
        <span>Token</span>
        <strong className="num">{appt.id.replace("A-", "")}</strong>
      </div>
      <div className="ticket__body">
        <b>{kind === "booked" ? "Appointment booked" : "Appointment cancelled"}</b>
        <span>
          {appt.patient_name}, with {appt.doctor_name}
        </span>
        <span className="num">
          {fmtDay(appt.starts_at, { weekday: "short", day: "numeric", month: "short" })}, {fmtTime(appt.starts_at)}
          {kind === "booked" && <> · Room {appt.room}</>}
        </span>
      </div>
    </div>
  );
}
