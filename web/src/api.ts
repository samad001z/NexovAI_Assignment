export type Slot = { id: string; starts_at: string; booked: boolean };
export type Doctor = { id: string; name: string; speciality: string; room: string; slots: Slot[] };
export type Appointment = {
  id: string;
  slot_id: string;
  doctor_id: string;
  doctor_name: string;
  speciality: string;
  room: string;
  patient_name: string;
  phone: string;
  status: "booked" | "cancelled";
  starts_at: string;
  created_at: string;
  cancelled_at: string | null;
};

export type ServerEvent =
  | { type: "availability"; doctor_ids: string[]; date: string | null }
  | { type: "booked"; appointment: Appointment }
  | { type: "cancelled"; appointment: Appointment }
  | { type: "call"; state: "connected" | "ended"; active: number }
  | { type: "reset" };

const get = <T,>(path: string): Promise<T> =>
  fetch(path).then((r) => {
    if (!r.ok) throw new Error(`${path} ${r.status}`);
    return r.json();
  });

export const api = {
  doctors: () => get<Doctor[]>("/api/doctors"),
  appointments: () => get<Appointment[]>("/api/appointments"),
  status: () => get<{ active_calls: number; stt: string; whisper_device: string }>("/api/status"),
  reset: () => fetch("/api/reset", { method: "POST" }),
};

// ---- formatting (clinic runs on IST regardless of the viewer's timezone) ----
const tz = "Asia/Kolkata";
export const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: tz });
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).replace(" ", " ");
export const fmtDay = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(iso).toLocaleDateString("en-GB", { timeZone: tz, ...opts }).replace(",", "");
export const minutesOfDay = (iso: string) => {
  const [h, m] = new Date(iso)
    .toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":")
    .map(Number);
  return h * 60 + m;
};
export const fmtPhone = (p: string) => (p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p);
