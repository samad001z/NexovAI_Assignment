import { useMemo } from "react";
import {
  CalendarCheckIcon,
  CalendarXIcon,
  MagnifyingGlassIcon,
  PhoneIncomingIcon,
  PhoneXIcon,
} from "@phosphor-icons/react";
import type { Appointment } from "../api";
import { fmtDay, fmtTime } from "../api";

/** Things only seen live (calls, availability checks). Bookings come from the appointments list. */
export type FeedItem = {
  id: string;
  at: string;
  kind: "call-start" | "call-end" | "check";
  doctorIds?: string[];
  date?: string | null;
};

type Row = { id: string; at: string; kind: FeedItem["kind"] | "booked" | "cancelled"; text: string; appt?: Appointment };

type Props = {
  activeCalls: number;
  feed: FeedItem[];
  appts: Appointment[];
  doctorName: (id: string) => string;
  onPick: (a: Appointment) => void;
};

const ICONS = {
  "call-start": PhoneIncomingIcon,
  "call-end": PhoneXIcon,
  check: MagnifyingGlassIcon,
  booked: CalendarCheckIcon,
  cancelled: CalendarXIcon,
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });

/** Staff rail: is Asha on a call right now, and what has she been doing. */
export function Activity({ activeCalls, feed, appts, doctorName, onPick }: Props) {
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = feed.map((f) => ({
      id: f.id,
      at: f.at,
      kind: f.kind,
      text:
        f.kind === "call-start"
          ? "A patient called Asha"
          : f.kind === "call-end"
            ? "Call ended"
            : `Asha checked ${(f.doctorIds ?? []).map(doctorName).join(", ")}${f.date ? `, ${fmtDay(`${f.date}T12:00:00+05:30`)}` : ""}`,
    }));
    for (const a of appts) {
      const when = `${a.doctor_name}, ${fmtDay(a.starts_at)} ${fmtTime(a.starts_at)}`;
      out.push({ id: `${a.id}-b`, at: a.created_at, kind: "booked", text: `Booked ${a.patient_name} with ${when}`, appt: a });
      if (a.status === "cancelled" && a.cancelled_at) {
        out.push({ id: `${a.id}-c`, at: a.cancelled_at, kind: "cancelled", text: `${a.patient_name} cancelled ${when}`, appt: a });
      }
    }
    return out.sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 40);
  }, [feed, appts, doctorName]);

  const onCall = activeCalls > 0;

  return (
    <section className="activity" aria-label="Asha's activity">
      <div className={`line-status ${onCall ? "is-on" : ""}`} role="status">
        <div className="line-status__orb" aria-hidden>
          {onCall && <span className="halo" />}
          <div className="orb" />
        </div>
        <div>
          <b>{onCall ? (activeCalls === 1 ? "Asha is on a call" : `Asha is on ${activeCalls} calls`) : "Asha is standing by"}</b>
          <span>{onCall ? "Updates appear below as she works" : "Patients call in from the patient line"}</span>
        </div>
      </div>

      <h2 className="activity__title">Activity</h2>
      {rows.length === 0 ? (
        <p className="activity__empty">Nothing yet today. Calls, checks and bookings show up here as they happen.</p>
      ) : (
        <ol className="feed">
          {rows.map((r) => {
            const Icon = ICONS[r.kind];
            const body = (
              <>
                <span className={`feed__icon feed__icon--${r.kind}`} aria-hidden>
                  <Icon size={15} weight="bold" />
                </span>
                <span className="feed__text">{r.text}</span>
                <time className="feed__time num" dateTime={r.at}>
                  {clock(r.at)}
                </time>
              </>
            );
            return (
              <li key={r.id}>
                {r.appt ? (
                  <button className="feed__row" onClick={() => onPick(r.appt!)}>
                    {body}
                  </button>
                ) : (
                  <div className="feed__row">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
