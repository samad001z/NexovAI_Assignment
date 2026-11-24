import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwiseIcon, ArrowSquareOutIcon, PhoneIcon } from "@phosphor-icons/react";
import { api, dayKey, type Appointment, type Doctor, type ServerEvent } from "./api";
import { Activity, type FeedItem } from "./components/Activity";
import { Appointments } from "./components/Appointments";
import { Brand } from "./components/Brand";
import { PhoneCall } from "./components/PhoneCall";
import { Schedule } from "./components/Schedule";
import { Stats } from "./components/Stats";
import { playChime } from "./sounds";
import { useCall } from "./useCall";

/** Staff page (/desk): the clinic's live view of everything Asha books and cancels, plus a test phone to call her. */
export default function DeskApp() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [day, setDay] = useState<string>("");
  const [focus, setFocus] = useState<Set<string>>(new Set());
  const [stamps, setStamps] = useState<Record<string, "booked" | "freed">>({});
  const [flash, setFlash] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [activeCalls, setActiveCalls] = useState(0);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const call = useCall();
  const onPhone = call.state !== "idle";
  const calling = useRef(false);
  useEffect(() => {
    calling.current = onPhone; // the phone plays its own chime for its own booking
  }, [onPhone]);

  const refresh = useCallback(async () => {
    try {
      const [d, a, st] = await Promise.all([api.doctors(), api.appointments(), api.status()]);
      setDoctors(d);
      setAppts(a);
      setActiveCalls(st.active_calls);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  const days = useMemo(() => {
    const set = new Set<string>();
    doctors.forEach((d) => d.slots.forEach((s) => set.add(dayKey(s.starts_at))));
    return [...set].sort();
  }, [doctors]);

  useEffect(() => {
    if (days.length && !days.includes(day)) setDay(days[0]);
  }, [days, day]);

  const doctorName = useCallback((id: string) => doctors.find((d) => d.id === id)?.name ?? "a doctor", [doctors]);
  const push = (item: Omit<FeedItem, "id" | "at">) =>
    setFeed((f) => [{ ...item, id: crypto.randomUUID(), at: new Date().toISOString() }, ...f].slice(0, 40));

  // Live updates from every call's tools, over SSE.
  useEffect(() => {
    void refresh();
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(fn, ms));
    const es = new EventSource("/api/events");
    es.onerror = () => setOffline(true);
    es.onopen = () => {
      setOffline(false);
      void refresh(); // catch up on anything missed while disconnected
    };
    es.onmessage = (m) => {
      const ev = JSON.parse(m.data) as ServerEvent;
      if (ev.type === "call") {
        setActiveCalls(ev.active);
        push({ kind: ev.state === "connected" ? "call-start" : "call-end" });
      } else if (ev.type === "availability") {
        setFocus(new Set(ev.doctor_ids));
        if (ev.date) setDay(ev.date);
        push({ kind: "check", doctorIds: ev.doctor_ids, date: ev.date });
        later(() => setFocus(new Set()), 8000);
      } else if (ev.type === "booked" || ev.type === "cancelled") {
        const a = ev.appointment;
        void refresh();
        setDay(dayKey(a.starts_at));
        setFocus(new Set([a.doctor_id]));
        setStamps((s) => ({ ...s, [a.slot_id]: ev.type === "booked" ? "booked" : "freed" }));
        setFlash(a.id);
        if (ev.type === "booked" && !calling.current) playChime();
        later(() => setFocus(new Set()), 4000);
        later(() => setFlash((f) => (f === a.id ? null : f)), 4000);
        later(() => setStamps(({ [a.slot_id]: _, ...rest }) => rest), 2400);
      } else if (ev.type === "reset") {
        setFeed([]);
        void refresh();
      }
    };
    return () => {
      es.close();
      timers.forEach(clearTimeout);
    };
  }, [refresh]);

  const bySlot = useMemo(
    () => new Map(appts.filter((a) => a.status === "booked").map((a) => [a.slot_id, a])),
    [appts],
  );

  const today = new Date()
    .toLocaleDateString("en-GB", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .replace(",", "");
  const hour = Number(new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const pick = (a: Appointment) => {
    setDay(dayKey(a.starts_at));
    setFocus(new Set([a.doctor_id]));
    document.querySelector(".schedule")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    window.setTimeout(() => setFocus(new Set()), 2200);
  };

  const reset = async () => {
    if (!window.confirm("Reset demo data? This deletes every appointment and reseeds the schedule.")) return;
    setResetting(true);
    try {
      await api.reset();
      setStamps({});
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className={`app ${onPhone ? "is-calling" : ""}`}>
      <header className="top">
        <Brand sub="Front desk" />
        <div className="top__right">
          <span className={`sync ${offline ? "sync--off" : ""}`} role="status">
            <i aria-hidden />
            {offline ? "Server offline" : "Live"}
          </span>
          <button className="btn btn--primary btn--call" onClick={() => void call.start()} disabled={offline || onPhone}>
            <PhoneIcon size={16} weight="fill" />
            Try call
          </button>
          <a className="btn btn--quiet" href="/" target="_blank" rel="noreferrer">
            <ArrowSquareOutIcon size={16} />
            Patient line
          </a>
          <button className="btn btn--quiet" onClick={reset} disabled={resetting || activeCalls > 0}>
            <ArrowCounterClockwiseIcon size={16} />
            {resetting ? "Resetting" : "Reset demo data"}
          </button>
        </div>
      </header>

      <div className="layout">
        <main className="content">
          <div className="intro">
            <h1>{greeting}</h1>
            <p>{today}</p>
          </div>
          {offline && loaded && (
            <p className="banner" role="alert">
              Can't reach the server on port 7860. Start it with <code>uvicorn app:app --port 7860</code> in <code>server/</code>.
            </p>
          )}
          <Stats doctors={doctors} appts={appts} loading={!loaded} />
          <Schedule doctors={doctors} days={days} day={day} onDay={setDay} focus={focus} stamps={stamps} bySlot={bySlot} />
          <Appointments items={appts} flash={flash} onPick={pick} loading={!loaded} />
        </main>

        <aside className="rail">
          {onPhone ? (
            <PhoneCall call={call} onCallAgain={() => void call.start()} />
          ) : (
            <Activity activeCalls={activeCalls} feed={feed} appts={appts} doctorName={doctorName} onPick={pick} />
          )}
        </aside>
      </div>
    </div>
  );
}
