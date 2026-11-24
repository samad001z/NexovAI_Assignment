import type { Appointment, Doctor } from "../api";
import { dayKey, fmtDay, fmtTime, minutesOfDay } from "../api";

const OPEN = 9 * 60;
const CLOSE = 18 * 60;
const STEP = 30;
const COLS = (CLOSE - OPEN) / STEP;

type Props = {
  doctors: Doctor[];
  days: string[];
  day: string;
  onDay: (d: string) => void;
  focus: Set<string>;
  stamps: Record<string, "booked" | "freed">;
  bySlot: Map<string, Appointment>;
};

export function Schedule({ doctors, days, day, onDay, focus, stamps, bySlot }: Props) {
  const hours = Array.from({ length: (CLOSE - OPEN) / 60 }, (_, i) => OPEN / 60 + i);

  return (
    <section className="schedule" aria-label="Doctor schedule">
      <div className="schedule__bar">
        <div>
          <h2>Doctor schedule</h2>
          <p className="muted">{day ? fmtDay(`${day}T12:00:00+05:30`, { weekday: "long", day: "numeric", month: "long" }) : "Loading"}</p>
        </div>
        <div className="days" role="tablist" aria-label="Day">
          {days.map((d) => {
            const iso = `${d}T12:00:00+05:30`;
            return (
              <button key={d} role="tab" aria-selected={d === day} className="day" onClick={() => onDay(d)}>
                <span>{fmtDay(iso, { weekday: "short" })}</span>
                <b>{fmtDay(iso, { day: "numeric" })}</b>
              </button>
            );
          })}
        </div>
      </div>

      {doctors.length === 0 && (
        <div className="grid grid--loading" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className="skeleton skeleton--row" />
          ))}
        </div>
      )}

      <div className="grid" style={{ ["--cols" as string]: COLS }}>
        <div className="grid__hours" aria-hidden>
          <span />
          {hours.map((h) => (
            <span key={h} style={{ gridColumn: `${2 + (h * 60 - OPEN) / STEP} / span 2` }}>
              {h > 12 ? h - 12 : h}
              {h >= 12 ? "pm" : "am"}
            </span>
          ))}
        </div>

        {doctors.map((doc) => {
          const slots = doc.slots.filter((s) => dayKey(s.starts_at) === day);
          const open = slots.filter((s) => !s.booked).length;
          return (
            <div key={doc.id} className={`row ${focus.has(doc.id) ? "is-focus" : ""}`}>
              <div className="row__who">
                <span className="avatar" aria-hidden>{initials(doc.name.replace("Dr. ", ""))}</span>
                <div>
                  <b>{doc.name}</b>
                  <span>{doc.speciality}</span>
                  <span>
                    <span className={open ? "row__open" : "row__open row__open--full"}>{open ? `${open} open` : "Fully booked"}</span>
                    {" "}· Room {doc.room}
                  </span>
                </div>
              </div>
              {slots.map((s) => {
                const appt = bySlot.get(s.id);
                const kind = appt ? "ours" : s.booked ? "taken" : "free";
                const col = 2 + (minutesOfDay(s.starts_at) - OPEN) / STEP;
                const label = `${doc.name}, ${fmtTime(s.starts_at)}, ${
                  appt ? `booked for ${appt.patient_name}` : s.booked ? "taken" : "free"
                }`;
                return (
                  <div
                    key={s.id}
                    className={`cell cell--${kind} ${stamps[s.id] ? `is-${stamps[s.id]}` : ""}`}
                    style={{ gridColumn: col }}
                    title={label}
                    aria-label={label}
                  >
                    {appt && <span>{initials(appt.patient_name)}</span>}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <ul className="legend">
        <li><i className="cell cell--free" />Open</li>
        <li><i className="cell cell--taken" />Taken</li>
        <li><i className="cell cell--ours" />Booked by Asha</li>
        <li className="legend__tz">Times in IST</li>
      </ul>
    </section>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
