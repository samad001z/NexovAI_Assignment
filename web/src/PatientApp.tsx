import { useEffect, useLayoutEffect, useState } from "react";
import { animate, stagger, utils } from "animejs";
import { ArrowDownIcon, PhoneIcon } from "@phosphor-icons/react";
import { api, dayKey, fmtDay, fmtTime, type Doctor } from "./api";
import { Brand } from "./components/Brand";
import { Console } from "./components/Console";
import { useCall } from "./useCall";
import "./patient.css";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Patient page (/): call Asha to book, check or cancel. Shows only public clinic
 * information and the caller's own call. No other patients' data reaches this page:
 * the booking ticket arrives over this call's own connection, not the staff event stream.
 */
export default function PatientApp() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [offline, setOffline] = useState(false);
  const call = useCall();
  const busy = call.state === "ringing" || call.state === "live";

  const load = () =>
    api
      .doctors()
      .then((d) => {
        setDoctors(d);
        setOffline(false);
      })
      .catch(() => setOffline(true));

  useEffect(() => {
    void load();
    localStorage.removeItem("banyan.voice"); // the old voice picker's saved choice
  }, []);
  // a booking or cancellation on this call changes the "next free" times
  useEffect(() => {
    if (call.receipt) void load();
  }, [call.receipt]);

  useLayoutEffect(() => {
    if (reduced()) return;
    const parts = document.querySelectorAll(".pt-hero [data-rise]");
    utils.set(parts, { opacity: 0, translateY: 18 });
    const a = animate(parts, { opacity: 1, translateY: 0, duration: 900, delay: stagger(70, { start: 80 }), ease: "outExpo" });
    return () => void a.revert();
  }, []);

  const callNow = () => {
    document.getElementById("talk")?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
    if (!busy) void call.start();
  };

  return (
    <div className={`pt ${call.state !== "idle" ? "is-calling" : ""}`}>
      <p className="pt-strip">
        Open <b>Monday to Saturday</b> · In a medical emergency, call <b>108</b>
      </p>

      <header className="pt-nav">
        <div className="pt-wrap">
          <Brand sub="Hyderabad" />
          <nav aria-label="Sections">
            <a href="#doctors">Doctors</a>
            <a href="#how">How it works</a>
            <a href="#languages">Languages</a>
          </nav>
          <button className="pill pill--ink pill--sm" onClick={callNow} disabled={offline || busy}>
            <PhoneIcon size={16} weight="fill" />
            Call Asha
          </button>
        </div>
      </header>

      <main>
        <section className="pt-hero">
          <div className="pt-hero__glow" aria-hidden />
          <div className="pt-wrap">
            <p className="eyebrow" data-rise>
              Banyan Clinic · Hyderabad
            </p>
            <div className="pt-hero__grid">
              <h1 data-rise>
                <span>See the right doctor.</span>
                <span className="pt-soft">Just ask Asha.</span>
              </h1>
              <div className="pt-hero__side" data-rise>
                <p>
                  Our receptionist answers every call in seconds. She books, checks and cancels appointments in English,
                  Hindi, Hinglish or Telugu. No app, no forms, no waiting on hold.
                </p>
                <div className="pt-hero__actions">
                  <button className="pill pill--ink" onClick={callNow} disabled={offline || busy}>
                    <PhoneIcon size={18} weight="fill" />
                    Call Asha now
                  </button>
                  <a className="pill pill--ghost" href="#doctors">
                    Our doctors
                    <ArrowDownIcon size={16} />
                  </a>
                </div>
              </div>
            </div>

            <dl className="facts" data-rise>
              <div>
                <dt>Specialists</dt>
                <dd className="num">{doctors.length || 5}</dd>
              </div>
              <div>
                <dt>Languages</dt>
                <dd className="num">4</dd>
              </div>
              <div>
                <dt>Typical reply</dt>
                <dd className="num">2–3 s</dd>
              </div>
            </dl>

            {offline && (
              <p className="pt-banner" role="alert">
                The clinic line is unavailable right now. Please try again in a few minutes.
              </p>
            )}

            <div id="talk">
              <Console call={call} onCall={callNow} disabled={offline} />
            </div>
          </div>
        </section>

        <section id="doctors" className="pt-sec">
          <div className="pt-wrap">
            <div className="pt-sec__head">
              <div>
                <p className="eyebrow">Our doctors</p>
                <h2>Five specialists, one call away.</h2>
              </div>
              <p>Times update as patients book. Ask Asha for any of them by name, or just describe what you need.</p>
            </div>
            <ul className="docs">
              {doctors.length === 0
                ? Array.from({ length: 5 }, (_, i) => (
                    <li key={i} className="doc-cell" aria-hidden>
                      <span className="skeleton skeleton--row" />
                      <span className="skeleton skeleton--row" />
                    </li>
                  ))
                : doctors.map((d, i) => {
                    const free = nextFree(d);
                    return (
                      <li key={d.id} className="doc-cell">
                        <span className="doc-cell__n num">0{i + 1}</span>
                        <span className="pt-avatar" aria-hidden>
                          {initials(d.name.replace("Dr. ", ""))}
                        </span>
                        <h3>{d.name}</h3>
                        <p>{d.speciality}</p>
                        <dl>
                          <div>
                            <dt>Hours</dt>
                            <dd className="num">{hours(d)}</dd>
                          </div>
                          <div>
                            <dt>Room</dt>
                            <dd className="num">{d.room}</dd>
                          </div>
                          <div>
                            <dt>Next free</dt>
                            <dd className={`num ${free ? "is-free" : ""}`}>{free ?? "Fully booked"}</dd>
                          </div>
                        </dl>
                      </li>
                    );
                  })}
              <li className="doc-cell doc-cell--ask">
                <h3>Not sure who to see?</h3>
                <p>Tell Asha what's bothering you, like “a skin rash” or “knee pain”, and she'll find the right specialist.</p>
                <button className="pill pill--saffron" onClick={callNow} disabled={offline || busy}>
                  <PhoneIcon size={18} weight="fill" />
                  Ask Asha
                </button>
              </li>
            </ul>
          </div>
        </section>

        <section id="how" className="pt-sec">
          <div className="pt-wrap">
            <div className="pt-sec__head">
              <div>
                <p className="eyebrow">How it works</p>
                <h2>A front desk that never puts you on hold.</h2>
              </div>
            </div>
            <ol className="steps">
              <li>
                <span className="num">01</span>
                <h3>Call Asha</h3>
                <p>Press the call button and allow your microphone. She picks up straight away, day or night.</p>
              </li>
              <li>
                <span className="num">02</span>
                <h3>Say what you need</h3>
                <p>“A skin doctor tomorrow evening” is enough. She finds the free slots and reads them out to you.</p>
              </li>
              <li>
                <span className="num">03</span>
                <h3>Get your token</h3>
                <p>She reads your mobile number back, books the slot and gives you a token to show at reception.</p>
              </li>
            </ol>
          </div>
        </section>

        <section id="languages" className="pt-sec">
          <div className="pt-wrap">
            <div className="pt-sec__head">
              <div>
                <p className="eyebrow">Languages</p>
                <h2>Speak the way you speak at home.</h2>
              </div>
              <p>Switch languages mid-sentence if you like. Asha follows Hinglish as easily as English.</p>
            </div>
            <div className="langs-grid">
              <article className="lang-card">
                <span className="lang-card__word">Hello</span>
                <q>Is Dr. Rao free on Friday morning?</q>
                <small>English · replies in English</small>
              </article>
              <article className="lang-card lang-card--glow">
                <span className="lang-card__word" lang="hi">
                  नमस्ते
                </span>
                <q lang="hi">कल शाम को स्किन डॉक्टर मिलेंगे?</q>
                <small>Hindi and Hinglish · replies in Hindi</small>
              </article>
              <article className="lang-card">
                <span className="lang-card__word" lang="te">
                  నమస్కారం
                </span>
                <q lang="te">నాకు రేపు అపాయింట్‌మెంట్ కావాలి.</q>
                <small>Telugu · understood, replies in English</small>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer className="pt-foot">
        <div className="pt-wrap">
          <Brand sub="Hyderabad" />
          <p>
            Asha is an AI receptionist. She books appointments but can't give medical advice. In an emergency, call{" "}
            <b>108</b>.
          </p>
          <small>© {new Date().getFullYear()} Banyan Clinic</small>
        </div>
      </footer>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** Consulting hours, read off the doctor's slots: "9 am to 1 pm". */
function hours(d: Doctor): string {
  const mins = d.slots.map((s) => {
    const [h, m] = new Date(s.starts_at)
      .toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })
      .split(":")
      .map(Number);
    return h * 60 + m;
  });
  if (!mins.length) return "By appointment";
  const label = (t: number) => {
    const h = Math.floor(t / 60);
    return `${h % 12 || 12} ${h < 12 ? "am" : "pm"}`;
  };
  return `${label(Math.min(...mins))} to ${label(Math.max(...mins) + 30)}`;
}

/** The doctor's earliest open slot: "Today, 4:30 pm", "Tomorrow, 10:00 am", "Fri 28 Nov, 9:30 am". */
function nextFree(d: Doctor): string | null {
  const now = Date.now();
  const slot = d.slots
    .filter((s) => !s.booked && Date.parse(s.starts_at) > now)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))[0];
  if (!slot) return null;
  const day = dayKey(slot.starts_at);
  const label =
    day === dayKey(new Date(now).toISOString())
      ? "Today"
      : day === dayKey(new Date(now + 86_400_000).toISOString())
        ? "Tomorrow"
        : fmtDay(slot.starts_at);
  return `${label}, ${fmtTime(slot.starts_at)}`;
}
