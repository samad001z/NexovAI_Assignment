"""HTTP server: WebRTC signalling for calls, REST for the dashboard, SSE for live updates.

Run:  uvicorn app:app --port 7860   (from the server/ folder)
"""

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import BackgroundTasks, FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pipecat.transports.smallwebrtc.request_handler import (  # noqa: E402
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

import db  # noqa: E402
import events  # noqa: E402
from bot import STT_ENGINE, run_bot  # noqa: E402

missing = [k for k in ("ELEVENLABS_API_KEY", "GOOGLE_API_KEY") if not os.getenv(k)]
if missing:
    raise SystemExit(f"Missing {', '.join(missing)}. Copy .env.example to .env and fill it in.")

db.init()
stt = None
if STT_ENGINE == "whisper":
    import stt  # optional: needs requirements-whisper.txt

    stt.preload_in_background()  # ~10 s on a warm cache; the first call would otherwise wait for it
webrtc = SmallWebRTCRequestHandler()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await webrtc.close()


app = FastAPI(title="Banyan Clinic front desk", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ---------- call signalling (used by the Pipecat browser client) ----------

@app.post("/api/offer")
async def offer(request: Request, background: BackgroundTasks):
    body = await request.json()
    req = SmallWebRTCRequest(
        sdp=body["sdp"],
        type=body["type"],
        pc_id=body.get("pc_id"),
        restart_pc=body.get("restart_pc"),
    )

    async def start(connection):
        background.add_task(run_bot, connection)

    return await webrtc.handle_web_request(req, start)


@app.patch("/api/offer")
async def ice_candidates(request: Request):
    body = await request.json()
    await webrtc.handle_patch_request(
        SmallWebRTCPatchRequest(
            pc_id=body["pc_id"],
            candidates=[IceCandidate(**c) for c in body.get("candidates", [])],
        )
    )
    return {"status": "ok"}


# ---------- dashboard data ----------

@app.get("/api/doctors")
def list_doctors():
    return db.schedule()


@app.get("/api/appointments")
def list_appointments():
    return db.appointments()


@app.get("/api/status")
def status():
    return {"active_calls": events.active_calls, "stt": STT_ENGINE, "whisper_device": stt.device_used if stt else None}


@app.post("/api/reset")
def reset():
    db.reset()
    events.publish("reset")
    return {"ok": True}


@app.get("/api/events")
async def stream(request: Request):
    q = events.subscribe()

    async def gen():
        try:
            yield "retry: 2000\n\n"
            while not await request.is_disconnected():
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": ping\n\n"  # keep proxies from closing the stream
        finally:
            events.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


# Serve the built dashboard (web/dist) from the same origin, if it exists.
dist = Path(__file__).parent.parent / "web" / "dist"
if dist.exists():
    from fastapi.responses import FileResponse

    @app.get("/desk")
    def desk_page():  # the staff page is the same single-page app, routed in the browser
        return FileResponse(dist / "index.html")

    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
