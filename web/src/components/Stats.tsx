import { useLayoutEffect, useRef } from "react";
import { animate } from "animejs";
import type { Appointment, Doctor } from "../api";

type Props = { doctors: Doctor[]; appts: Appointment[]; loading: boolean };

/** Today's numbers, all derived from live data. A number counts to its new value when a call changes it. */
export function Stats({ doctors, appts, loading }: Props) {
  const now = Date.now();
  // starts_at carries +05:30, so compare as instants, never as strings
  const ahead = (iso: string) => Date.parse(iso) > now;
  const upcoming = appts.filter((a) => a.status === "booked" && ahead(a.starts_at)).length;
  const cancelled = appts.filter((a) => a.status === "cancelled").length;
  const open = doctors.reduce((n, d) => n + d.slots.filter((s) => !s.booked && ahead(s.starts_at)).length, 0);
  const total = doctors.reduce((n, d) => n + d.slots.filter((s) => ahead(s.starts_at)).length, 0);
  const fill = total ? Math.round(((total - open) / total) * 100) : 0;

  const items = [
    { label: "Upcoming bookings", value: upcoming, note: "made by Asha" },
    { label: "Open slots", value: open, note: "next 5 working days" },
    { label: "Schedule filled", value: fill, suffix: "%", note: `${total - open} of ${total} slots` },
    { label: "Cancellations", value: cancelled, note: "slots released" },
  ];

  return (
    <section className="stats" aria-label="Today at a glance">
      {items.map((s) => (
        <div key={s.label} className="stat">
          <span className="stat__label">{s.label}</span>
          {loading ? (
            <span className="skeleton skeleton--num" aria-hidden />
          ) : (
            <b className="stat__value num">
              <Count value={s.value} />
              {s.suffix}
            </b>
          )}
          <span className="stat__note">{s.note}</span>
        </div>
      ))}
    </section>
  );
}

function Count({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);

  // the span has no React children: this effect owns its text, so there is no one-frame flash
  useLayoutEffect(() => {
    const from = shown.current;
    shown.current = value;
    if (!el.current || from === value || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (el.current) el.current.textContent = String(value);
      return;
    }
    const n = { v: from };
    const a = animate(n, {
      v: value,
      duration: 700,
      ease: "outCubic",
      onUpdate: () => {
        if (el.current) el.current.textContent = String(Math.round(n.v));
      },
    });
    return () => void a.pause();
  }, [value]);

  return <span ref={el} />;
}
