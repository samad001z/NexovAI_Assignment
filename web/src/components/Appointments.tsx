import { useState } from "react";
import { CalendarCheckIcon } from "@phosphor-icons/react";
import type { Appointment } from "../api";
import { fmtDay, fmtPhone, fmtTime } from "../api";

type Props = { items: Appointment[]; flash: string | null; onPick: (a: Appointment) => void; loading: boolean };
type Filter = "booked" | "cancelled" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "booked", label: "Upcoming" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

export function Appointments({ items, flash, onPick, loading }: Props) {
  const [filter, setFilter] = useState<Filter>("booked");
  const count = (f: Filter) => (f === "all" ? items.length : items.filter((a) => a.status === f).length);
  const shown = (filter === "all" ? items : items.filter((a) => a.status === filter))
    // upcoming reads soonest first; the other views read newest first
    .toSorted((a, b) => (filter === "booked" ? a.starts_at.localeCompare(b.starts_at) : b.created_at.localeCompare(a.created_at)));

  return (
    <section className="appts" aria-labelledby="appts-title">
      <div className="appts__bar">
        <h2 id="appts-title">Appointments</h2>
        <div className="seg" role="tablist" aria-label="Filter appointments">
          {FILTERS.map((f) => (
            <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              <span className="num">{count(f.key)}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="appts__list" aria-hidden>
          <span className="skeleton skeleton--row" />
          <span className="skeleton skeleton--row" />
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <CalendarCheckIcon size={28} weight="duotone" aria-hidden />
          <b>{filter === "cancelled" ? "No cancellations" : "No appointments yet"}</b>
          <p>{filter === "cancelled" ? "Cancelled visits will show up here." : "Call Asha and ask for a doctor. Bookings appear here the moment they are made."}</p>
        </div>
      ) : (
        <ol className="appts__list">
          {shown.map((a) => (
            <li key={a.id} className={`appt appt--${a.status} ${flash === a.id ? "is-flash" : ""}`}>
              <button onClick={() => onPick(a)} aria-label={`Show ${a.patient_name}'s slot on the schedule`}>
                <span className="appt__token num">{a.id.replace("A-", "")}</span>
                <span className="appt__who">
                  <b>{a.patient_name}</b>
                  <span className="num">{fmtPhone(a.phone)}</span>
                </span>
                <span className="appt__doc">
                  <b>{a.doctor_name}</b>
                  <span>
                    {a.speciality} · Room {a.room}
                  </span>
                </span>
                <time className="appt__when num" dateTime={a.starts_at}>
                  <b>{fmtTime(a.starts_at)}</b>
                  <span>{fmtDay(a.starts_at, { weekday: "short", day: "numeric", month: "short" })}</span>
                </time>
                <span className={`badge badge--${a.status}`}>{a.status === "booked" ? "Booked" : "Cancelled"}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
