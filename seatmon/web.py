"""HTTP/WebSocket API; routes retain the public v1 contract."""
import base64, dataclasses, threading, time, uuid
from typing import Optional
import cv2
from pydantic import BaseModel
from .config import Settings, ApiError, CONTRACT_VERSION, BACKEND_VERSION
from .camera import SourceSpec, SyntheticSource, CvSource, FfmpegGatewaySource, ffmpeg_executable, frame_valid, mask_url, render_no_signal
from .runtime import Runtime
from .telemetry import Hub, _iso

class SourceReq(BaseModel):
    type: str; usb_index: int = 0; url: str = ""; path: str = ""; loop: bool = True
    target_fps: float = 15; resolution: Optional[list[int]] = None


class SourceTestReq(SourceReq):
    duration_s: float = 3.0


class SeatReq(BaseModel):
    seat_id: str = ""; name: str = "Seat"; camera_id: str = "cam0"
    polygon: list[list[float]]; enabled: bool = True


def create_app(rt: Runtime, initial_source: Optional[SourceSpec] = None):
    import asyncio
    from contextlib import asynccontextmanager
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, StreamingResponse, Response
    from pydantic import BaseModel

    @asynccontextmanager
    async def lifespan(app):
        rt.hub.loop = asyncio.get_running_loop()
        await asyncio.get_running_loop().run_in_executor(None, rt.load_model)   # slow: keep the loop free
        rt.start()
        if initial_source: rt.camera.start(initial_source)
        yield
        rt.shutdown()

    app = FastAPI(title="Seat Monitor", version=BACKEND_VERSION, lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"],
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(ApiError)
    async def _api_err(_: Request, e: ApiError):
        return JSONResponse({"error": {"code": e.code, "message": e.message, "hint": e.hint, "retryable": e.retryable}}, e.status)

    P = "/api/v1"

    @app.get(f"{P}/health")
    def health(): return rt.health()

    @app.get(f"{P}/system/model")
    def model_info():
        a = rt.adapter
        return {"name": a.name, "version": a.version, "task": a.task, "device": a.device, "classes_used": a.classes_used,
                "checkpoint": a.checkpoint, "license": a.license, "simulated": a.simulated, "mode": rt.inference_strategy}

    @app.get(f"{P}/system/metrics")
    def metrics(): return rt.metrics()

    @app.get(f"{P}/occupancy")
    def occupancy(): return rt.occupancy_summary()

    @app.post(f"{P}/sources/select")
    def select(req: SourceReq):
        if req.type not in ("usb", "rtsp", "http_mjpeg", "file", "synthetic"):
            raise ApiError("SOURCE_NOT_FOUND", f"Unknown source type {req.type}", status=422)
        if req.type == "usb" and req.usb_index < 0:
            raise ApiError("SOURCE_INVALID", "USB index must be non-negative", status=422)
        rt.camera.start(SourceSpec(req.type, req.usb_index, req.url, req.path, req.loop, req.target_fps,
                                   tuple(req.resolution) if req.resolution else None))
        return {"camera_id": "cam0", "state": rt.camera.state, "frame_size": rt.camera.frame_size}

    @app.post(f"{P}/sources/test")
    def test_source(req: SourceTestReq):
        """Probe a source without replacing the active camera."""
        if req.type not in ("usb", "rtsp", "http_mjpeg", "file", "synthetic"):
            raise ApiError("SOURCE_NOT_FOUND", f"Unknown source type {req.type}", status=422)
        if not (0.5 <= req.duration_s <= 15):
            raise ApiError("SOURCE_INVALID", "duration_s must be between 0.5 and 15 seconds", status=422)
        spec = SourceSpec(req.type, req.usb_index, req.url, req.path, req.loop, req.target_fps,
                          tuple(req.resolution) if req.resolution else None)
        src = SyntheticSource(fps=spec.target_fps) if spec.type == "synthetic" else (FfmpegGatewaySource(spec) if spec.type == "rtsp" and ffmpeg_executable() else CvSource(spec))
        started = time.monotonic(); frames = 0; first_frame_ms = None; errors = 0; img = None
        try:
            src.open()
            deadline = started + req.duration_s
            while time.monotonic() < deadline:
                box = {}
                t = threading.Thread(target=lambda: box.setdefault("frame", src.read()), daemon=True)
                t.start(); t.join(min(2.0, max(0.1, deadline - time.monotonic())))
                if t.is_alive():
                    errors += 1; break
                img = box.get("frame")
                if frame_valid(img):
                    frames += 1
                    if first_frame_ms is None: first_frame_ms = round((time.monotonic() - started) * 1000, 1)
                else:
                    errors += 1
            elapsed = max(0.001, time.monotonic() - started)
            return {"opened": True, "frames": frames, "measured_fps": round(frames / elapsed, 1),
                    "first_frame_ms": first_frame_ms, "decode_errors": errors,
                    "frame_size": [int(img.shape[1]), int(img.shape[0])] if frame_valid(img) else None,
                    "source": {"type": spec.type, "url": mask_url(spec.url) if spec.url else "",
                               "backend": getattr(src, "backend", "opencv_ffmpeg")}}
        except ApiError:
            raise
        except Exception as exc:
            raise ApiError("SOURCE_CONNECT_FAILED", f"Could not test {mask_url(spec.url or spec.path)}",
                           str(exc), retryable=True, status=502) from exc
        finally:
            src.close()

    @app.post(f"{P}/sources/stop")
    def stop_src(): rt.camera.stop(); return {"state": rt.camera.state}

    @app.get(f"{P}/seats")
    def seats(): return rt.seat_status()

    @app.post(f"{P}/seats")
    def add_seat(req: SeatReq):
        sid = req.seat_id or f"seat-{uuid.uuid4().hex[:6]}"
        rt.upsert_seat(sid, req.name, req.polygon, req.camera_id, req.enabled); return {"seat_id": sid}

    @app.put(f"{P}/seats/{{seat_id}}")
    def put_seat(seat_id: str, req: SeatReq):
        rt.upsert_seat(seat_id, req.name, req.polygon, req.camera_id, req.enabled); return {"seat_id": seat_id}

    @app.delete(f"{P}/seats/{{seat_id}}")
    def del_seat(seat_id: str):
        if rt.seats.pop(seat_id, None) is None: raise ApiError("NOT_FOUND", "No such seat", status=404)
        return {"deleted": True}

    @app.post(f"{P}/seats/{{seat_id}}/crop-preview")
    def crop_preview(seat_id: str):
        seat, fr = rt.seats.get(seat_id), rt.camera.latest()
        if seat is None: raise ApiError("NOT_FOUND", "No such seat", status=404)
        if fr is None: raise ApiError("SOURCE_CONNECT_FAILED", "No frame available yet", retryable=True, status=409)
        c = make_crop(fr.image, seat.polygon, rt.s.crop_padding)
        ok, buf = cv2.imencode(".jpg", c.img)
        return {"image_jpeg_base64": base64.b64encode(buf).decode(), "crop_box_px": [c.x0, c.y0, c.img.shape[1], c.img.shape[0]],
                "frame_size": [c.frame_w, c.frame_h]}

    @app.get(f"{P}/settings")
    def get_settings(): return dataclasses.asdict(rt.s)

    @app.put(f"{P}/settings")
    def put_settings(body: dict):
        new = dataclasses.replace(rt.s, **{k: v for k, v in body.items() if hasattr(rt.s, k)})
        new.validate(); rt.s = new                                    # atomic swap, applied live
        rt.emit("config_changed", "info", "Settings updated"); return dataclasses.asdict(new)

    @app.get(f"{P}/events")
    def events(limit: int = 200, seat_id: str = "", type: str = ""):
        out = [e for e in rt.events if (not seat_id or e["seat_id"] == seat_id) and (not type or e["type"] == type)]
        return out[-limit:][::-1]

    @app.post(f"{P}/alerts/{{alert_id}}/ack")
    def ack(alert_id: str):
        for e in rt.events:
            if e["alert_id"] == alert_id:
                rt.acked.add(f"{e['seat_id']}:{e.get('episode_id', '')}"); return {"acknowledged": True}
        raise ApiError("NOT_FOUND", "Unknown alert", status=404)

    @app.post(f"{P}/alerts/{{alert_id}}/snooze")
    def snooze(alert_id: str, body: dict):
        for e in rt.events:
            if e["alert_id"] == alert_id:
                rt.snooze_until[e["seat_id"]] = time.monotonic() + float(body.get("seconds", 300)); return {"snoozed": True}
        raise ApiError("NOT_FOUND", "Unknown alert", status=404)

    NO_SIGNAL = render_no_signal()

    @app.get(f"{P}/stream/{{camera_id}}.mjpg")
    async def stream(camera_id: str):
        async def gen():
            last = -1
            while True:
                age = rt.camera.frame_age()
                live = age is not None and age <= rt.s.stale_timeout_s
                jpg, jid = rt.camera.jpeg()
                if live and jpg and jid != last:
                    last, out = jid, (rt.annotated_jpeg() or jpg)
                elif not live: out = NO_SIGNAL                       # never serve a frozen frame as "live"
                else: await asyncio.sleep(0.02); continue
                yield b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(out) + out + b"\r\n"
                await asyncio.sleep(1 / 15)
        w, h = rt.camera.frame_size or (0, 0)
        return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame",
                                 headers={"X-Frame-Width": str(w), "X-Frame-Height": str(h), "Cache-Control": "no-store"})

    @app.get(f"{P}/stream/{{camera_id}}/snapshot.jpg")
    def snapshot(camera_id: str):
        fr = rt.camera.latest()
        if fr is None: return Response(NO_SIGNAL, media_type="image/jpeg", status_code=409)
        return Response(cv2.imencode(".jpg", fr.image)[1].tobytes(), media_type="image/jpeg")

    if rt.demo:
        @app.post(f"{P}/demo/trigger")
        def demo_trigger():
            return rt.emit("vacancy_confirmed", "critical", "Simulated vacancy (demo trigger)", "seat-1",
                           vacant_duration_s=rt.s.vacancy_seconds, episode_id=f"demo_{int(time.time())}")

    @app.websocket(f"{P}/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        ch = Hub.Chan(); ch.wake = asyncio.Event(); rt.hub.chans.add(ch)
        await sock.send_json({"type": "hello", "ts": _iso(), "data": {
            "contract_version": CONTRACT_VERSION, "backend_version": BACKEND_VERSION, "simulated": rt.simulated,
            "snapshot": {"seats": rt.seat_status(), "settings": dataclasses.asdict(rt.s), "health": rt.health()}}})

        async def sender():
            while True:
                await ch.wake.wait(); ch.wake.clear()
                while ch.queue: await sock.send_json(ch.queue.popleft())           # events first, in order
                latest, ch.latest = list(ch.latest.values()), {}
                for m in latest: await sock.send_json(m)

        async def receiver():
            while True:
                msg = await asyncio.wait_for(sock.receive_json(), timeout=30)       # silent client => drop
                if msg.get("type") == "ping": await sock.send_json({"type": "pong", "ts": _iso()})

        tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except WebSocketDisconnect:
            pass
        finally:
            for t in tasks: t.cancel()
            rt.hub.chans.discard(ch)
    return app


# ───────────────────────────── entry point ─────────────────────────────
