"""Coordinates capture, batched inference, seat evidence and events."""
import collections, dataclasses, logging, threading, time
from dataclasses import dataclass
import cv2
import numpy as np
from .config import Settings, BACKEND_VERSION, CONTRACT_VERSION
from .geometry import validate_polygon, make_crop
from .models import Adapter
from .decisions import SeatTracker, decide, prepare_image
from .camera import CameraManager
from .telemetry import Hub, pct, hardware_info, _iso
log = logging.getLogger("seatmon.runtime")

DEMO_POLY = [(0.28, 0.28), (0.56, 0.28), (0.56, 0.88), (0.28, 0.88)]


@dataclass
class Seat:
    seat_id: str; name: str; polygon: list; camera_id: str = "cam0"; enabled: bool = True
    tracker: SeatTracker = None; last_fid: int = -1; infer_failed: bool = False


class Runtime:
    def __init__(self, settings: Settings, adapter: Adapter, demo: bool = False):
        self.s, self.adapter, self.demo = settings, adapter, demo
        self.model_state, self.model_msg = "loading", None
        self.camera, self.hub = CameraManager(), Hub()
        self.seats: dict[str, Seat] = {}
        self.events: collections.deque = collections.deque(maxlen=1000)
        self.lat = collections.deque(maxlen=600); self.pipe = collections.deque(maxlen=600)
        self.proc_ts = collections.deque(maxlen=60); self.conf_hist = np.zeros(10, int)
        self.inference_errors = 0; self._err_last = 0.0
        self.detections = {}
        self.inference_strategy, self.last_batch_seats = "batched_roi", 0
        self.skipped_frames, self.last_processed_frame = 0, 0
        self.acked: set[str] = set(); self.snooze_until: dict[str, float] = {}
        self._cam_fault = False; self._eid = 0; self._aid = 0
        # Opening a source is normal startup, not a failure/recovery cycle.  In
        # particular, do not discard the first seconds of evidence just because
        # the capture thread has not delivered its first frame yet.
        self._camera_has_connected = False
        self.t0 = time.monotonic(); self._stop = threading.Event(); self._thread = None
        self.lock = threading.RLock()

    # ---- lifecycle
    def load_model(self):
        try:
            self.adapter.load(); self.model_state, self.model_msg = "ready", None
            self.emit("model_loaded", "info", f"Model ready: {self.adapter.name} on {self.adapter.device}")
        except Exception as e:                                       # model failure must not kill the server
            self.model_state, self.model_msg = "error", f"{type(e).__name__}: {e}"
            log.error("model load failed: %s", self.model_msg)

    def start(self):
        self._thread = threading.Thread(target=self._loop, name="pipeline", daemon=True); self._thread.start()

    def shutdown(self):
        self._stop.set()
        if self._thread: self._thread.join(timeout=3)
        self.camera.stop()

    # ---- seats
    def upsert_seat(self, seat_id, name, polygon, camera_id="cam0", enabled=True) -> Seat:
        poly = validate_polygon(polygon)
        with self.lock:
            old = self.seats.get(seat_id)
            seat = Seat(seat_id, name, poly, camera_id, enabled, old.tracker if old else SeatTracker(seat_id))
            if old: seat.tracker.reset_evidence()                    # new region => old evidence is void
            self.seats[seat_id] = seat
        self.emit("config_changed", "info", f"Seat '{name}' region saved", seat_id)
        return seat

    # ---- events
    @property
    def simulated(self) -> bool:
        return self.adapter.simulated or bool(self.camera.spec and self.camera.spec.type == "synthetic")

    def emit(self, typ, severity, message, seat_id=None, **extra) -> dict:
        with self.lock:
            self._eid += 1
            alert_id = None
            if typ == "vacancy_confirmed":
                ep = extra.get("episode_id", "")
                key = f"{seat_id}:{ep}"
                if key in self.acked: return {}                      # acknowledged episode: no repeats
                self._aid += 1; alert_id = f"alt_{self._aid:06d}"
            sound = typ == "vacancy_confirmed" and time.monotonic() >= self.snooze_until.get(seat_id, 0)
            ev = {"event_id": f"evt_{self._eid:06d}", "alert_id": alert_id, "type": typ, "severity": severity,
                  "seat_id": seat_id, "camera_id": "cam0", "message": message, "sound": sound,
                  "simulated": self.simulated, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **extra}
            self.events.append(ev)
        self.hub.publish({"type": "event", "ts": ev["created_at"], "data": ev})
        return ev

    # ---- status
    def health(self) -> dict:
        age = self.camera.frame_age()
        ok = self.model_state == "ready" and self.camera.state == "connected" and age is not None and age <= self.s.stale_timeout_s
        return {"status": "ok" if ok else "degraded", "backend_version": BACKEND_VERSION, "contract_version": CONTRACT_VERSION,
                "uptime_s": round(time.monotonic() - self.t0, 1), "simulated": self.simulated,
                "camera": {"state": self.camera.state, "backend": self.camera.backend, "last_frame_age_ms": None if age is None else int(age * 1000),
                           "message": (self.camera.last_error or {}).get("message")},
                "model": {"state": self.model_state, "name": self.adapter.name, "message": self.model_msg,
                           "device": self.adapter.device, "hardware": hardware_info(self.adapter.device)}}

    def seat_status(self) -> list[dict]:
        now = time.monotonic()
        return [{"seat_id": x.seat_id, "camera_id": x.camera_id, "name": x.name, "state": x.tracker.state, "confidence": x.tracker.confidence,
                 "vacant_for_s": round(x.tracker.vacant_for(now), 1), "polygon": x.polygon, "enabled": x.enabled}
                for x in self.seats.values()]

    def occupancy_summary(self) -> dict:
        seats = [seat for seat in self.seats.values() if seat.enabled]
        occupied = sum(seat.tracker.state == "occupied" for seat in seats)
        return {"expected_seats": len(seats), "occupied_seats": occupied,
                "vacant_seats": sum(seat.tracker.state == "vacant" for seat in seats),
                "actual_people": occupied, "unconfirmed_seats": sum(seat.tracker.state in ("uncertain", "transitioning") for seat in seats)}

    def annotated_jpeg(self) -> bytes | None:
        frame = self.camera.latest()
        if frame is None: return None
        image = frame.image.copy(); h, w = image.shape[:2]
        colors = {"occupied": (44, 190, 92), "vacant": (50, 80, 238), "uncertain": (30, 180, 245), "transitioning": (170, 170, 170), "camera_unavailable": (50, 80, 238), "model_error": (50, 80, 238)}
        for seat in self.seats.values():
            if not seat.enabled: continue
            poly = np.array([[round(x * (w - 1)), round(y * (h - 1))] for x, y in seat.polygon], np.int32)
            color = colors.get(seat.tracker.state, (170, 170, 170))
            cv2.polylines(image, [poly], True, color, 2, cv2.LINE_AA)
            x, y = poly.min(axis=0)
            label = f"{seat.name}: {seat.tracker.state.upper()}"
            cv2.putText(image, label, (int(x), max(18, int(y) - 6)), cv2.FONT_HERSHEY_SIMPLEX, .55, color, 2, cv2.LINE_AA)
            _, boxes = self.detections.get(seat.seat_id, (0, []))
            for box in boxes:
                x1, y1, x2, y2 = [int(v * (w - 1)) for v in box["xyxy_norm"]]
                cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
                cv2.putText(image, f"PERSON {box['conf']:.0%}", (x1, max(18, y1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, .48, color, 1, cv2.LINE_AA)
        summary = self.occupancy_summary()
        text = f"SEATS {summary['occupied_seats']}/{summary['expected_seats']}  PEOPLE {summary['actual_people']}"
        cv2.rectangle(image, (8, 8), (min(w - 8, 360), 38), (20, 20, 20), -1)
        cv2.putText(image, text, (14, 29), cv2.FONT_HERSHEY_SIMPLEX, .62, (255, 255, 255), 2, cv2.LINE_AA)
        edge = self.s.preview_max_edge
        if max(w, h) > edge:
            scale = edge / max(w, h); image = cv2.resize(image, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, self.s.jpeg_quality])
        return encoded.tobytes() if ok else None

    def metrics(self) -> dict:
        ts = list(self.proc_ts)
        fps = None if len(ts) < 3 or ts[-1] == ts[0] else round((len(ts) - 1) / (ts[-1] - ts[0]), 1)
        return {"capture_fps": self.camera.capture_fps(), "processing_fps": fps,
                "inference_ms": {"p50": pct(self.lat, 50), "p95": pct(self.lat, 95), "p99": pct(self.lat, 99),
                                 "last": round(self.lat[-1], 1) if self.lat else None},
                "pipeline_ms": {"p50": pct(self.pipe, 50), "p95": pct(self.pipe, 95)},
                "dropped_frames": self.camera.dropped_invalid, "inference_errors": self.inference_errors,
                "confidence_hist": {"bins": [round(i / 10, 1) for i in range(11)], "counts": self.conf_hist.tolist()},
                "device": self.adapter.device, "hardware": hardware_info(self.adapter.device), "simulated": self.simulated,
                "occupancy": self.occupancy_summary(), "inference_strategy": self.inference_strategy,
                "batch_seats": self.last_batch_seats, "skipped_frames": self.skipped_frames}

    # ---- the pipeline loop (10 Hz tick; inference when due; staleness judged by frame age)
    def _loop(self):
        last_infer = last_metrics = last_health = 0.0
        while not self._stop.wait(0.05):
            try:
                tick_started = time.monotonic()
                self._tick(last_infer, last_metrics, last_health)
                now = time.monotonic()
                if tick_started - last_infer >= 1 / self.s.target_inference_fps: last_infer = tick_started
                if now - last_metrics >= 1.0:
                    last_metrics = now; self.hub.publish({"type": "metrics", "ts": _iso(), "data": self.metrics()}, "metrics")
                if now - last_health >= 5.0:
                    last_health = now; self.hub.publish({"type": "health", "ts": _iso(), "data": self.health()}, "health")
            except Exception:                                         # the loop must survive anything
                log.exception("pipeline tick failed")

    def _tick(self, last_infer, last_metrics, last_health):
        now, s = time.monotonic(), self.s
        fr, age = self.camera.latest(), self.camera.frame_age()
        cam_ok = fr is not None and age is not None and age <= s.stale_timeout_s and self.camera.state == "connected"
        if cam_ok:
            self._camera_has_connected = True
        if not cam_ok and not self._cam_fault:
            self._cam_fault = True
            self.emit("camera_unavailable", "warning", (self.camera.last_error or {}).get("message") or "No valid frames")
            self.hub.publish({"type": "health", "ts": _iso(), "data": self.health()}, "health")
        elif cam_ok and self._cam_fault:
            self._cam_fault = False; self.emit("camera_recovered", "info", "Frames resumed")
        due = now - last_infer >= 1 / s.target_inference_fps
        seats = [seat for seat in list(self.seats.values()) if seat.enabled]
        pending = [seat for seat in seats if cam_ok and due and fr.frame_id != seat.last_fid and self.model_state == "ready"]
        observations = {}
        if pending:
            try:
                started = time.perf_counter()
                crops = [make_crop(fr.image, seat.polygon, s.crop_padding) for seat in pending]
                shared = s.inference_mode == "full_frame" or (s.inference_mode == "auto" and len(pending) >= 4)
                self.inference_strategy = "full_frame" if shared else "batched_roi"
                if shared:
                    boxes, scores = self.adapter.infer(prepare_image(fr.image, s.environment))
                    results = [(boxes - np.array([crop.x0, crop.y0, crop.x0, crop.y0], np.float32), scores) for crop in crops]
                else:
                    results = []
                    for offset in range(0, len(crops), s.batch_size):
                        results.extend(self.adapter.infer_batch([prepare_image(c.img, s.environment) for c in crops[offset:offset + s.batch_size]]))
                inf_ms = (time.perf_counter() - started) * 1000
                for seat, crop, (boxes, scores) in zip(pending, crops, results):
                    obs = decide(boxes, scores, crop, s)
                    obs.inference_ms = inf_ms
                    observations[seat.seat_id] = obs
                    seat.last_fid, seat.infer_failed = fr.frame_id, False
                    self.detections[seat.seat_id] = (fr.t_mono, obs.boxes)
                    self.conf_hist[min(9, int(obs.person_conf * 10))] += 1
                self.lat.append(inf_ms)
                self.pipe.append((time.monotonic() - fr.t_mono) * 1000)
                self.proc_ts.append(now)
                self.last_batch_seats = len(pending)
                self.skipped_frames += max(0, fr.frame_id - self.last_processed_frame - 1) if self.last_processed_frame else 0
                self.last_processed_frame = fr.frame_id
            except Exception as e:
                for seat in pending: seat.infer_failed = True
                self.inference_errors += 1
                if now - self._err_last > 10:
                    self._err_last = now
                    self.emit("inference_error", "warning", f"{type(e).__name__}: {e}")
        for seat in seats:
            if not cam_ok and not self._camera_has_connected:
                # Keep startup in its neutral state.  Once a camera has been
                # connected, normal fault/recovery handling below takes over.
                continue
            obs = observations.get(seat.seat_id)
            raw = obs.raw if obs else None
            model_ok = self.model_state == "ready" and not seat.infer_failed
            prev = seat.tracker.state
            for e in seat.tracker.step(now, s, cam_ok, model_ok, raw):
                typ = e.pop("type"); sev = e.pop("severity"); msg = e.pop("message"); e.pop("prev", None)
                self.emit(typ, sev, msg, seat.seat_id, **e)
            if seat.tracker.state != prev:
                self.hub.publish({"type": "state_change", "ts": _iso(), "data": {
                    "seat_id": seat.seat_id, "from": prev, "to": seat.tracker.state, "since": _iso()}})
            if obs:
                self.hub.publish({"type": "inference", "ts": _iso(), "data": {
                    "seat_id": seat.seat_id, "camera_id": seat.camera_id, "frame_id": fr.frame_id, "raw_label": obs.raw,
                    "state": seat.tracker.state, "confidence": seat.tracker.confidence,
                    "score_smoothed": round(seat.tracker.ema, 3), "person_conf": round(obs.person_conf, 3),
                    "overlap": round(obs.overlap, 3), "boxes": obs.boxes, "quality": obs.quality,
                    "vacant_for_s": round(seat.tracker.vacant_for(now), 1),
                    "latency": {"inference_ms": round(obs.inference_ms, 1), "pipeline_ms": round((time.monotonic() - fr.t_mono) * 1000, 1)},
                    "simulated": self.simulated}}, ("inference", seat.seat_id))
