"""SQLite storage for doctors, slots and appointments.

Mock data is seeded on first run: five doctors, each with 30-minute slots
for the next five working days. The data reseeds itself once every slot is
in the past, so a demo left for a week still has a schedule. reset() reseeds
on demand.
"""

import random
import re
import os
import sqlite3
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
DB_PATH = Path(os.getenv("CLINIC_DB", Path(__file__).parent / "clinic.db"))

DOCTORS = [
    # id, name, speciality, room, (start hour, end hour)
    ("d1", "Dr. Ananya Rao", "General Physician", "101", (9, 13)),
    ("d2", "Dr. Farhan Siddiqui", "Cardiologist", "204", (10, 14)),
    ("d3", "Dr. Meera Iyer", "Dermatologist", "112", (14, 18)),
    ("d4", "Dr. Vikram Reddy", "Orthopedic Surgeon", "310", (11, 15)),
    ("d5", "Dr. Sana Qureshi", "Pediatrician", "118", (9, 12)),
]

# Plain words callers use, mapped to a speciality. The prompt asks the model to
# do this too; doing it here as well means "skin doctor" still finds Dr. Iyer
# when the model passes the caller's words through unchanged.
SYNONYMS = {
    "General Physician": ["general", "physician", "fever", "cold", "cough", "checkup", "check-up", "gp", "family"],
    "Cardiologist": ["heart", "cardio", "cardiac", "chest", "bp", "blood pressure"],
    "Dermatologist": ["skin", "derma", "rash", "acne", "hair", "allergy"],
    "Orthopedic Surgeon": ["bone", "bones", "joint", "joints", "knee", "back", "ortho", "fracture", "spine", "shoulder"],
    "Pediatrician": ["child", "children", "kid", "kids", "baby", "infant", "paediatric", "pediatric", "son", "daughter"],
}

# Hour ranges (IST, start inclusive, end exclusive) for "morning" and so on.
PARTS_OF_DAY = {"morning": (0, 12), "afternoon": (12, 16), "evening": (16, 24)}

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA foreign_keys=ON")


def now() -> datetime:
    return datetime.now(IST)


def _working_days(start: date, count: int) -> list[date]:
    days, d = [], start
    while len(days) < count:
        if d.weekday() < 6:  # clinic is open Monday to Saturday
            days.append(d)
        d += timedelta(days=1)
    return days


SCHEMA = """
CREATE TABLE IF NOT EXISTS doctors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    speciality TEXT NOT NULL,
    room TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    starts_at TEXT NOT NULL,
    booked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL REFERENCES slots(id),
    doctor_id TEXT NOT NULL REFERENCES doctors(id),
    patient_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled')),
    created_at TEXT NOT NULL,
    cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_slots_doctor_time ON slots(doctor_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_slots_time ON slots(starts_at);
CREATE INDEX IF NOT EXISTS idx_appts_phone ON appointments(phone, status);
-- one live booking per slot, enforced by the database and not only by app code
CREATE UNIQUE INDEX IF NOT EXISTS uq_appts_live_slot ON appointments(slot_id) WHERE status = 'booked';
"""


def init(force: bool = False) -> None:
    with _lock:
        cur = _conn.cursor()
        if force:
            cur.executescript(
                "DROP TABLE IF EXISTS appointments; DROP TABLE IF EXISTS slots; DROP TABLE IF EXISTS doctors;"
            )
        cur.executescript(SCHEMA)
        empty = cur.execute("SELECT COUNT(*) FROM doctors").fetchone()[0] == 0
        stale = not empty and cur.execute(
            "SELECT 1 FROM slots WHERE starts_at > ? LIMIT 1", (now().isoformat(),)
        ).fetchone() is None
        if stale:
            cur.executescript("DELETE FROM appointments; DELETE FROM slots; DELETE FROM doctors;")
        if empty or stale:
            _seed(cur)
        _conn.commit()


def _seed(cur: sqlite3.Cursor) -> None:
    rng = random.Random(7)
    start = now().date() + timedelta(days=1)
    rows, n = [], 0
    cur.executemany("INSERT INTO doctors VALUES (?,?,?,?)", [d[:4] for d in DOCTORS])
    for doc_id, _name, _spec, _room, (h0, h1) in DOCTORS:
        for day in _working_days(start, 5):
            t = datetime(day.year, day.month, day.day, h0, tzinfo=IST)
            while t.hour < h1:
                n += 1
                # roughly a third of slots are already taken, so the data looks real
                rows.append((f"S{n}", doc_id, t.isoformat(), 1 if rng.random() < 0.33 else 0))
                t += timedelta(minutes=30)
    cur.executemany("INSERT INTO slots VALUES (?,?,?,?)", rows)


def reset() -> None:
    init(force=True)


# ---------- phone numbers ----------

def normalize_phone(raw: str) -> str | None:
    """Keep digits only. Accept a 10-digit Indian mobile, optionally prefixed with 91 or 0."""
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if len(digits) == 10 and digits[0] in "6789" else None


# ---------- reads ----------

def doctors() -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute("SELECT * FROM doctors ORDER BY id")]


def find_doctors(query: str | None) -> list[dict]:
    """Match a doctor by (partial) name, speciality or a plain word like "skin". Empty query returns everyone."""
    docs = doctors()
    if not query:
        return docs
    q = " " + re.sub(r"[^a-z]+", " ", query.lower()) + " "
    tokens = set(q.split())
    names = [w for w in tokens - _STOP if len(w) > 2]
    hits = []
    for d in docs:
        hay = f"{d['name']} {d['speciality']}".lower()
        syn = SYNONYMS.get(d["speciality"], [])
        # whole words only, so "son" does not match "person"
        if any(w in hay for w in names) or any(f" {s.replace('-', ' ')} " in q for s in syn):
            hits.append(d)
    return hits


_STOP = {"doctor", "the", "and", "for", "with", "has", "have", "need", "want", "see", "about", "some", "any", "please", "appointment"}


def slots(
    doctor_id: str | None = None,
    on: str | None = None,
    only_free: bool = True,
    part_of_day: str | None = None,
) -> list[dict]:
    sql = "SELECT s.*, d.name AS doctor_name FROM slots s JOIN doctors d ON d.id = s.doctor_id WHERE s.starts_at > ?"
    args: list = [now().isoformat()]
    if doctor_id:
        sql += " AND s.doctor_id = ?"
        args.append(doctor_id)
    if on:
        sql += " AND substr(s.starts_at, 1, 10) = ?"
        args.append(on)
    if part_of_day in PARTS_OF_DAY:
        h0, h1 = PARTS_OF_DAY[part_of_day]
        sql += " AND CAST(substr(s.starts_at, 12, 2) AS INTEGER) >= ? AND CAST(substr(s.starts_at, 12, 2) AS INTEGER) < ?"
        args += [h0, h1]
    if only_free:
        sql += " AND s.booked = 0"
    sql += " ORDER BY s.starts_at"
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args)]


def schedule() -> list[dict]:
    """Every doctor with every slot, in one query, for the dashboard."""
    with _lock:
        rows = _conn.execute(
            """SELECT d.id, d.name, d.speciality, d.room, s.id AS slot_id, s.starts_at, s.booked
               FROM doctors d LEFT JOIN slots s ON s.doctor_id = d.id
               ORDER BY d.id, s.starts_at"""
        ).fetchall()
    out: dict[str, dict] = {}
    for r in rows:
        doc = out.setdefault(r["id"], {"id": r["id"], "name": r["name"], "speciality": r["speciality"], "room": r["room"], "slots": []})
        if r["slot_id"]:
            doc["slots"].append({"id": r["slot_id"], "starts_at": r["starts_at"], "booked": bool(r["booked"])})
    return list(out.values())


_APPT_SQL = """SELECT a.*, s.starts_at, d.name AS doctor_name, d.speciality, d.room
               FROM appointments a
               JOIN slots s ON s.id = a.slot_id
               JOIN doctors d ON d.id = a.doctor_id"""


def appointments() -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(_APPT_SQL + " ORDER BY a.created_at DESC")]


def appointment(appt_id: str) -> dict | None:
    with _lock:
        row = _conn.execute(_APPT_SQL + " WHERE a.id = ?", (appt_id,)).fetchone()
    return dict(row) if row else None


def active_appointments_for(phone: str) -> list[dict]:
    """Upcoming, still-booked appointments for one number, soonest first."""
    with _lock:
        rows = _conn.execute(
            _APPT_SQL + " WHERE a.phone = ? AND a.status = 'booked' AND s.starts_at > ? ORDER BY s.starts_at",
            (phone, now().isoformat()),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------- writes ----------

class BookingError(Exception):
    pass


def book(slot_id: str, phone: str, patient_name: str) -> dict:
    with _lock:
        slot = _conn.execute("SELECT * FROM slots WHERE id = ?", (slot_id,)).fetchone()
        if not slot:
            raise BookingError("That slot does not exist. Check availability again.")
        if slot["booked"]:
            raise BookingError("That slot was just taken.")
        if slot["starts_at"] <= now().isoformat():
            raise BookingError("That slot is in the past.")
        clash = _conn.execute(
            """SELECT 1 FROM appointments a JOIN slots s ON s.id = a.slot_id
               WHERE a.phone = ? AND a.status = 'booked' AND s.doctor_id = ? AND s.starts_at > ?""",
            (phone, slot["doctor_id"], now().isoformat()),
        ).fetchone()
        if clash:
            raise BookingError("This number already has an upcoming appointment with this doctor.")

        count = _conn.execute("SELECT COUNT(*) FROM appointments").fetchone()[0]
        appt_id = f"A-{1001 + count}"
        try:
            # the WHERE booked = 0 guard makes the claim atomic even without the lock
            claimed = _conn.execute("UPDATE slots SET booked = 1 WHERE id = ? AND booked = 0", (slot_id,)).rowcount
            if not claimed:
                raise BookingError("That slot was just taken.")
            _conn.execute(
                "INSERT INTO appointments VALUES (?,?,?,?,?,?,?,?)",
                (appt_id, slot_id, slot["doctor_id"], patient_name.strip()[:60], phone, "booked", now().isoformat(), None),
            )
            _conn.commit()
        except (BookingError, sqlite3.IntegrityError) as e:
            _conn.rollback()
            raise BookingError("That slot was just taken.") from e
    return appointment(appt_id)  # type: ignore[return-value]


def cancel(appt_id: str) -> dict:
    with _lock:
        row = _conn.execute("SELECT * FROM appointments WHERE id = ?", (appt_id,)).fetchone()
        if not row or row["status"] != "booked":
            raise BookingError("No active appointment with that reference.")
        _conn.execute(
            "UPDATE appointments SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
            (now().isoformat(), appt_id),
        )
        _conn.execute("UPDATE slots SET booked = 0 WHERE id = ?", (row["slot_id"],))
        _conn.commit()
    return appointment(appt_id)  # type: ignore[return-value]


if __name__ == "__main__":
    # Self-check against a throwaway database: python db.py
    import tempfile

    _conn.close()
    _conn = sqlite3.connect(Path(tempfile.mkdtemp()) / "t.db", check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    init()
    assert normalize_phone("+91 98480 22137") == "9848022137"
    assert normalize_phone("098480 22137") == "9848022137"
    assert normalize_phone("12345") is None and normalize_phone("1234567890") is None
    assert [d["id"] for d in find_doctors("skin doctor")] == ["d3"]
    assert [d["id"] for d in find_doctors("Dr Rao")] == ["d1"]
    assert [d["id"] for d in find_doctors("my kid has a fever")] == ["d1", "d5"]
    evening = slots("d3", part_of_day="evening")
    assert evening and all(int(s["starts_at"][11:13]) >= 16 for s in evening)
    free = slots("d1")[0]
    a = book(free["id"], "9848022137", "Ravi Kumar")
    assert a["status"] == "booked" and a["doctor_name"] == "Dr. Ananya Rao"
    for bad in (lambda: book(free["id"], "9000000000", "X"), lambda: book(slots("d1")[0]["id"], "9848022137", "Ravi")):
        try:
            bad()
            raise AssertionError("expected BookingError")
        except BookingError:
            pass
    assert [x["id"] for x in active_appointments_for("9848022137")] == [a["id"]]
    assert cancel(a["id"])["status"] == "cancelled"
    assert active_appointments_for("9848022137") == []
    assert len(schedule()) == 5 and all(d["slots"] for d in schedule())
    print("db self-check ok")
