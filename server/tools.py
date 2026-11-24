"""The tools the LLM can call, plus their schemas.

Every handler returns plain JSON to the LLM, and publishes an event so the
dashboard updates live while the caller is still on the line.
"""

from datetime import datetime

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import EndWorkerFrame, FunctionCallResultProperties, TTSSpeakFrame
from pipecat.processors.frameworks.rtvi import RTVIServerMessageFrame
from pipecat.services.llm_service import FunctionCallParams

import db
import events

GOODBYE = ("Thank you for calling Banyan Clinic. Take care, and have a good day.",
           "बैनियन क्लिनिक को कॉल करने के लिए धन्यवाद। अपना ख्याल रखिए।")
MAX_SLOTS = 6
# What a model fills in when it never asked; a booking needs the patient's real name.
PLACEHOLDER_NAMES = {"caller", "patient", "unknown", "user", "customer", "name", "n/a", "na", "none", "sir", "madam"}  # the agent has to say these out loud, so keep the list short


def spoken_time(iso: str) -> dict:
    # Built by hand: strftime's "%-d" and "%-I" do not exist on Windows.
    t = datetime.fromisoformat(iso)
    return {
        "day": f"{t:%A} {t.day} {t:%B}",
        "time": f"{t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}",
        "date": t.date().isoformat(),
    }


# ---------- schemas ----------

check_availability_schema = FunctionSchema(
    name="check_doctor_availability",
    description=(
        "Look up free appointment slots. Search by doctor name, speciality or the caller's own words, "
        "optionally for one date and part of the day. Call with no arguments to list all doctors."
    ),
    properties={
        "doctor": {
            "type": "string",
            "description": "Doctor name or speciality, e.g. 'Dr Rao', 'Dermatologist', or the caller's words like 'skin doctor'.",
        },
        "date": {"type": "string", "description": "Date in YYYY-MM-DD, if the caller asked for a specific day."},
        "part_of_day": {
            "type": "string",
            "enum": ["morning", "afternoon", "evening"],
            "description": "Morning is before 12, afternoon 12 to 4, evening after 4.",
        },
    },
    required=[],
)

book_schema = FunctionSchema(
    name="book_appointment",
    description="Book a free slot for the caller. Only call after reading the phone number back and the caller confirming it.",
    properties={
        "slot_id": {"type": "string", "description": "slot_id from check_doctor_availability."},
        "phone": {"type": "string", "description": "Caller's 10-digit mobile number, digits only."},
        "patient_name": {"type": "string", "description": "Name of the patient."},
        "phone_confirmed": {
            "type": "boolean",
            "description": "True only if you read the number back and the caller said it is correct.",
        },
    },
    required=["slot_id", "phone", "patient_name", "phone_confirmed"],
)

find_schema = FunctionSchema(
    name="find_my_appointments",
    description="List the caller's upcoming appointments, found by phone number. Use when they ask when or with whom they are booked.",
    properties={
        "phone": {"type": "string", "description": "Caller's 10-digit mobile number, digits only."},
        "phone_confirmed": {
            "type": "boolean",
            "description": "True only if you read the number back and the caller said it is correct.",
        },
    },
    required=["phone", "phone_confirmed"],
)

cancel_schema = FunctionSchema(
    name="cancel_appointment",
    description=(
        "Cancel the caller's appointment, found by phone number. If the number has more than "
        "one appointment, the result lists them; ask which one and call again with appointment_id."
    ),
    properties={
        "phone": {"type": "string", "description": "Caller's 10-digit mobile number, digits only."},
        "phone_confirmed": {
            "type": "boolean",
            "description": "True only if you read the number back and the caller said it is correct.",
        },
        "appointment_id": {"type": "string", "description": "Only when the caller has several appointments."},
    },
    required=["phone", "phone_confirmed"],
)

end_call_schema = FunctionSchema(
    name="end_call",
    description=(
        "Hang up. Call this once the caller has nothing else and is saying goodbye. "
        "It says a closing line for you, so do not say goodbye yourself."
    ),
    properties={},
    required=[],
)

TOOLS = ToolsSchema(standard_tools=[check_availability_schema, book_schema, find_schema, cancel_schema, end_call_schema])


# ---------- helpers ----------

async def _confirmed_phone(params: FunctionCallParams) -> str | None:
    """Return the normalised number, or answer the LLM with why not and return None."""
    a = params.arguments
    if not a.get("phone_confirmed"):
        await params.result_callback({"ok": False, "error": "Read the phone number back and get a yes first."})
        return None
    phone = db.normalize_phone(str(a.get("phone", "")))
    if not phone:
        await params.result_callback({"ok": False, "error": "That is not a valid 10-digit mobile number. Ask again."})
        return None
    return phone


async def _tell_caller(params: FunctionCallParams, kind: str, appt: dict) -> None:
    """Send the result to this caller's browser only, over the call's own data channel.
    (The SSE stream goes to staff and carries every booking; patients must not see those.)"""
    await params.llm.push_frame(RTVIServerMessageFrame(data={"type": kind, "appointment": appt}))


# Said the moment a tool starts, so the caller isn't left in silence while the
# tool and the follow-up LLM call run (1.5-3 s). Not added to the LLM context.
HOLD = {
    "check": ("One moment, let me check.", "एक मिनट, मैं देख लेती हूँ।"),
    "find": ("Let me look that up.", "एक मिनट, मैं देख लेती हूँ।"),
    "book": ("Okay, booking that now.", "ठीक है, मैं बुक कर रही हूँ।"),
    "cancel": ("Okay, cancelling that now.", "ठीक है, मैं कैंसल कर रही हूँ।"),
}


def _speaks_hindi(params: FunctionCallParams) -> bool:
    """Whether the caller's last message was in Devanagari (Hindi or Hinglish)."""
    last = next((m for m in reversed(params.context.messages) if isinstance(m, dict) and m.get("role") == "user"), {})
    text = last.get("content", "")
    if not isinstance(text, str):
        text = " ".join(p.get("text", "") for p in text if isinstance(p, dict))
    return any("ऀ" <= ch <= "ॿ" for ch in text)


async def _hold(params: FunctionCallParams, kind: str) -> None:
    """Speak a short holding line in the caller's language."""
    await params.llm.push_frame(TTSSpeakFrame(HOLD[kind][_speaks_hindi(params)], append_to_context=False))


def _brief(appt: dict) -> dict:
    return {"appointment_id": appt["id"], "doctor": appt["doctor_name"], "room": appt["room"], **spoken_time(appt["starts_at"])}


# ---------- handlers ----------

async def check_doctor_availability(params: FunctionCallParams):
    await _hold(params, "check")
    a = params.arguments
    on, part = a.get("date"), a.get("part_of_day")
    matches = db.find_doctors(a.get("doctor"))

    if not matches:
        all_docs = [{"name": d["name"], "speciality": d["speciality"]} for d in db.doctors()]
        await params.result_callback({"found": False, "message": "No doctor matched.", "doctors": all_docs})
        return

    result = []
    for d in matches:
        free = db.slots(d["id"], on, part_of_day=part)
        entry = {
            "doctor": d["name"],
            "speciality": d["speciality"],
            "room": d["room"],
            "free_slots": [{"slot_id": s["id"], **spoken_time(s["starts_at"])} for s in free[:MAX_SLOTS]],
            "more_available": max(0, len(free) - MAX_SLOTS),
        }
        if not free and (on or part):
            # nothing in the window they asked for: hand the agent the nearest alternative
            later = db.slots(d["id"])
            if later:
                entry["next_free"] = {"slot_id": later[0]["id"], **spoken_time(later[0]["starts_at"])}
        result.append(entry)

    events.publish("availability", doctor_ids=[d["id"] for d in matches], date=on)
    await params.result_callback({"found": True, "results": result})


async def book_appointment(params: FunctionCallParams):
    phone = await _confirmed_phone(params)
    if not phone:
        return
    a = params.arguments
    name = str(a.get("patient_name") or "").strip()
    if len(name) < 2 or name.lower() in PLACEHOLDER_NAMES:
        await params.result_callback({"ok": False, "error": "Ask the patient's name before booking."})
        return
    await _hold(params, "book")
    try:
        appt = db.book(str(a.get("slot_id", "")), phone, name)
    except db.BookingError as e:
        await params.result_callback({"ok": False, "error": str(e)})
        return

    events.publish("booked", appointment=appt)
    await _tell_caller(params, "booked", appt)
    await params.result_callback({"ok": True, **_brief(appt)})


async def find_my_appointments(params: FunctionCallParams):
    phone = await _confirmed_phone(params)
    if not phone:
        return
    await _hold(params, "find")
    active = db.active_appointments_for(phone)
    await params.result_callback({"ok": True, "appointments": [_brief(x) for x in active]})


async def cancel_appointment(params: FunctionCallParams):
    phone = await _confirmed_phone(params)
    if not phone:
        return

    active = db.active_appointments_for(phone)
    if not active:
        await params.result_callback({"ok": False, "error": "No upcoming appointment found for this number."})
        return

    target_id = params.arguments.get("appointment_id")
    if not target_id:
        if len(active) > 1:
            await params.result_callback({"ok": False, "needs_choice": True, "appointments": [_brief(x) for x in active]})
            return
        target_id = active[0]["id"]
    elif target_id not in {x["id"] for x in active}:
        await params.result_callback({"ok": False, "error": "That appointment does not belong to this number."})
        return

    await _hold(params, "cancel")
    appt = db.cancel(target_id)
    events.publish("cancelled", appointment=appt)
    await _tell_caller(params, "cancelled", appt)
    await params.result_callback({"ok": True, "cancelled": True, **_brief(appt)})


async def end_call(params: FunctionCallParams):
    # Say the closing line, then end the pipeline once that audio has played out.
    await params.result_callback({"ok": True}, properties=FunctionCallResultProperties(run_llm=False))
    await params.llm.push_frame(TTSSpeakFrame(GOODBYE[_speaks_hindi(params)]))
    await params.llm.push_frame(EndWorkerFrame(reason="caller finished"))


def register(llm) -> None:
    llm.register_function("check_doctor_availability", check_doctor_availability)
    llm.register_function("book_appointment", book_appointment)
    llm.register_function("find_my_appointments", find_my_appointments)
    llm.register_function("cancel_appointment", cancel_appointment)
    llm.register_function("end_call", end_call)
