"""
Smart Vacant-Seat Monitoring: reference backend (single entry point).

Design rules (why the code looks the way it does):
  1. Core logic (ROI, decision, state machine, camera, pipeline) has NO web dependency.
     FastAPI is imported only inside create_app(), so the core is unit-testable anywhere.
  2. The state machine is a pure-ish class driven by an injected clock -> deterministic tests.
  3. Camera health is judged by *frame age*, not by whether read() returns, because RTSP
     reads can block forever. Staleness is checked on a 10 Hz tick independent of capture.
  4. "No new evidence" (raw=None) is different from "uncertain". Time passing with no new
     frame must never be counted as an uncertain/vacant observation.
  5. Camera fault or model fault => dedicated states, timer reset, never "vacant".
  6. One worker, no --reload (a second process would grab the camera twice).
"""
import argparse, base64, collections, dataclasses, logging, math, os, random, sys, threading, time, uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS",
                      "rtsp_transport;tcp|stimeout;5000000|fflags;nobuffer|flags;low_delay")
import cv2
import numpy as np
from pydantic import BaseModel

cv2.setNumThreads(1)  # don't fight the model runtime for cores
log = logging.getLogger("seatmon")
CONTRACT_VERSION, BACKEND_VERSION = "1.0", "0.1.0"


# ───────────────────────────── settings ─────────────────────────────
@dataclass
class Settings:
    vacancy_seconds: float = 10.0       # 300 is typical in production
    cooldown_seconds: float = 120.0
    occupied_conf: float = 0.45
    low_conf: float = 0.20
    min_overlap_occ: float = 0.35       # share of the person box inside the ROI polygon
    min_overlap_any: float = 0.05
    enter_occupied: float = 0.60        # hysteresis band on the smoothed score
    exit_occupied: float = 0.35
    smoothing_tau_s: float = 1.5        # time-constant EMA: independent of FPS
    confirm_s: float = 1.0              # threshold must be crossed this long to flip
    show_transition_s: float = 0.6
    uncertain_hold_s: float = 2.0
    uncertain_warn_seconds: float = 30.0
    stale_timeout_s: float = 3.0
    recovery_grace_s: float = 3.0
    crop_padding: float = 0.10
    target_inference_fps: float = 5.0
    min_sharpness: float = 1.0

    def validate(self) -> None:
        checks = [
            (1 <= self.vacancy_seconds <= 86400, "vacancy_seconds"),
            (0 <= self.cooldown_seconds <= 86400, "cooldown_seconds"),
            (0 < self.low_conf < self.occupied_conf <= 1, "low_conf/occupied_conf"),
            (0 < self.exit_occupied < self.enter_occupied < 1, "exit/enter_occupied"),
            (0.1 <= self.smoothing_tau_s <= 30, "smoothing_tau_s"),
            (0.5 <= self.stale_timeout_s <= 60, "stale_timeout_s"),
            (0 <= self.crop_padding <= 1, "crop_padding"),
            (0.2 <= self.target_inference_fps <= 30, "target_inference_fps"),
        ]
        bad = [n for ok, n in checks if not ok]
        if bad:
            raise ApiError("SETTINGS_INVALID", f"Invalid: {', '.join(bad)}", status=422)


class ApiError(Exception):
    def __init__(self, code: str, message: str, hint: str = "", status: int = 400, retryable: bool = False):
        super().__init__(message)
        self.code, self.message, self.hint, self.status, self.retryable = code, message, hint, status, retryable


# ───────────────────────────── ROI + crop ─────────────────────────────
def _orient(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _segments_cross(p1, p2, p3, p4) -> bool:
    d1, d2, d3, d4 = _orient(p3, p4, p1), _orient(p3, p4, p2), _orient(p1, p2, p3), _orient(p1, p2, p4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def polygon_area(poly) -> float:
    s = 0.0
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def validate_polygon(poly) -> list[tuple[float, float]]:
    if not (3 <= len(poly) <= 12):
        raise ApiError("ROI_INVALID", "Region needs 3 to 12 points", status=422)
    pts = [(float(x), float(y)) for x, y in poly]
    if any(not (0 <= x <= 1 and 0 <= y <= 1) for x, y in pts):
        raise ApiError("ROI_INVALID", "Coordinates must be normalized to [0,1]", status=422)
    if polygon_area(pts) < 0.005:
        raise ApiError("ROI_INVALID", "Region is smaller than 0.5% of the frame", status=422)
    n = len(pts)
    for i in range(n):
        for j in range(i + 1, n):
            if abs(i - j) in (1, n - 1):
                continue  # adjacent edges share a vertex
            if _segments_cross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]):
                raise ApiError("ROI_INVALID", "Region edges cross each other", status=422)
    return pts


@dataclass
class Crop:
    img: np.ndarray        # BGR crop (padded bbox of the polygon, NOT masked, context helps detection)
    mask: np.ndarray       # uint8, 255 inside the polygon, same size as img
    x0: int
    y0: int
    frame_w: int
    frame_h: int


def make_crop(frame: np.ndarray, poly_norm, padding: float) -> Crop:
    """Always denormalize against the size of the frame being processed, never a preview size."""
    h, w = frame.shape[:2]
    pts = np.array([[round(x * (w - 1)), round(y * (h - 1))] for x, y in poly_norm], dtype=np.int32)
    bx1, by1 = pts.min(axis=0); bx2, by2 = pts.max(axis=0)
    px, py = int((bx2 - bx1) * padding), int((by2 - by1) * padding)
    x0, y0 = max(0, bx1 - px), max(0, by1 - py)
    x1, y1 = min(w, bx2 + px + 1), min(h, by2 + py + 1)
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ApiError("ROI_INVALID", "Region is too small in pixels", status=422)
    mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
    cv2.fillPoly(mask, [pts - np.array([x0, y0], dtype=np.int32)], 255)
    return Crop(frame[y0:y1, x0:x1], mask, int(x0), int(y0), w, h)


# ───────────────────────────── device selection ─────────────────────────────
def _npu_available() -> bool:
    """Best-effort NPU probe (torch_npu / vendor runtimes expose a torch NPU backend)."""
    try:
        import torch
        backend = getattr(torch.backends, "npu", None)
        return bool(backend is not None and getattr(backend, "is_available", lambda: False)())
    except Exception:                                   # noqa: BLE001
        return False


def pick_device(pref: str = "auto") -> str:
    """Best available compute: explicit pref > GPU (cuda) > NPU > Apple MPS > CPU."""
    if pref and pref != "auto":
        return pref
    import torch
    if torch.cuda.is_available():
        return "cuda:0"
    if _npu_available():
        return "npu:0"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ───────────────────────────── model adapters ─────────────────────────────
class Adapter:
    """Every adapter returns only person boxes+scores in CROP pixel coordinates.
    Everything else (overlap, thresholds, smoothing, states) is model-agnostic."""
    name = "base"; version = "0"; license = "n/a"; task = "detect"; simulated = False
    device = "cpu"; classes_used = ["person"]; checkpoint = ""

    def load(self) -> None: ...
    def infer(self, bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        raise NotImplementedError


class SimulatedBlobAdapter(Adapter):
    """Finds the synthetic scene's orange 'person' by colour. A STAND-IN, flagged simulated."""
    name, version, simulated = "simulated-colour-blob", "1", True
    license = "n/a (demo stand-in, not a real)"

    def infer(self, bgr):
        m = cv2.inRange(bgr, (5, 80, 200), (60, 160, 255))
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            return np.zeros((0, 4), np.float32), np.zeros((0,), np.float32)
        c = max(cnts, key=cv2.contourArea)
        if cv2.contourArea(c) < 0.004 * bgr.shape[0] * bgr.shape[1]:
            return np.zeros((0, 4), np.float32), np.zeros((0,), np.float32)
        x, y, w, h = cv2.boundingRect(c)
        return np.array([[x, y, x + w, y + h]], np.float32), np.array([0.90], np.float32)


class YoloAdapter(Adapter):
    """Ultralytics YOLO (COCO person=0). AGPL-3.0 / Enterprise licence: verify before shipping."""
    license = "AGPL-3.0 or Ultralytics Enterprise (verify for commercial use)"

    def __init__(self, path: str, device: str = "auto"):
        self.checkpoint, self._dev_pref = path, device
        self.name = os.path.splitext(os.path.basename(path))[0]

    def load(self) -> None:
        import torch
        from ultralytics import YOLO  # lazy: core must import without it
        self.device = pick_device(self._dev_pref)     # GPU -> NPU -> Apple MPS -> CPU
        torch.set_num_threads(min(4, os.cpu_count() or 4))
        self._m = YOLO(self.checkpoint)                      # load by LOCAL path
        if self._m.names.get(0) != "person":
            raise RuntimeError(f"Unexpected class map: {self._m.names.get(0)!r} (expected 'person')")
        self.version = getattr(__import__("ultralytics"), "__version__", "?")
        self._half = self.device.startswith("cuda")
        for _ in range(3):                                   # warm-up (first call is slow)
            self._m.predict(np.zeros((640, 640, 3), np.uint8), device=self.device, verbose=False)

    def infer(self, bgr):
        r = self._m.predict(bgr, imgsz=640, conf=0.15, classes=[0], device=self.device,
                            half=self._half, verbose=False)[0]
        return r.boxes.xyxy.cpu().numpy().astype(np.float32), r.boxes.conf.cpu().numpy().astype(np.float32)


# ───────────────────────────── per-frame decision ─────────────────────────────
@dataclass
class Observation:
    raw: str                 # occupied | vacant | uncertain
    person_conf: float
    overlap: float
    boxes: list[dict]
    quality: dict
    inference_ms: float = 0.0


def crop_quality(img: np.ndarray, s: Settings) -> dict:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    bright, sharp = float(g.mean()), float(cv2.Laplacian(g, cv2.CV_32F).var())
    return {"brightness": round(bright, 1), "blur": round(sharp, 1),
            "ok": 15 <= bright <= 245 and sharp >= s.min_sharpness}


def decide(boxes: np.ndarray, scores: np.ndarray, crop: Crop, s: Settings) -> Observation:
    q = crop_quality(crop.img, s)
    best_conf, best_ov, any_cand, occ = 0.0, 0.0, False, False
    out = []
    for (x1, y1, x2, y2), sc in zip(boxes, scores):
        xa, ya = max(0, int(x1)), max(0, int(y1))
        xb, yb = min(crop.mask.shape[1], int(x2)), min(crop.mask.shape[0], int(y2))
        area = max(1.0, float((x2 - x1) * (y2 - y1)))
        inter = float(np.count_nonzero(crop.mask[ya:yb, xa:xb])) if xb > xa and yb > ya else 0.0
        ov = inter / area                      # share of the PERSON inside the seat polygon
        out.append({"cls": "person", "conf": round(float(sc), 3),
                    "xyxy_norm": [round((x1 + crop.x0) / crop.frame_w, 4), round((y1 + crop.y0) / crop.frame_h, 4),
                                  round((x2 + crop.x0) / crop.frame_w, 4), round((y2 + crop.y0) / crop.frame_h, 4)]})
        if ov >= s.min_overlap_any and sc >= s.low_conf:
            any_cand = True
            if sc > best_conf:
                best_conf, best_ov = float(sc), ov
            if sc >= s.occupied_conf and ov >= s.min_overlap_occ:
                occ = True
    if not q["ok"]:
        raw = "uncertain"                      # bad image must never read as "vacant"
    elif occ:
        raw = "occupied"
    elif any_cand:
        raw = "uncertain"
    else:
        raw = "vacant"
    return Observation(raw, best_conf, best_ov, out, q)


# ───────────────────────────── seat state machine ─────────────────────────────
class SeatTracker:
    """Time-constant EMA + hysteresis + confirmation window + vacancy timer + alert dedupe.
    step() takes `now` explicitly, so tests drive it with a fake clock."""

    def __init__(self, seat_id: str):
        self.seat_id = seat_id
        self.reset_evidence()
        self.state = "transitioning"
        self.episode = 0
        self.alerted_at: Optional[float] = None
        self._fault: Optional[str] = None
        self._recover_until = 0.0
        self.last_t: Optional[float] = None
        self.uncertain_warned = False

    def reset_evidence(self):
        self.ema, self.stable = 0.5, None
        self.cross_target, self.cross_since = None, 0.0
        self.disagree_since: Optional[float] = None
        self.uncertain_since: Optional[float] = None
        self.vacant_since: Optional[float] = None

    @property
    def confidence(self) -> Optional[float]:
        return round(max(self.ema, 1 - self.ema), 3) if self.state in ("occupied", "vacant") else None

    def vacant_for(self, now: float) -> float:
        return 0.0 if self.vacant_since is None else max(0.0, now - self.vacant_since)

    def step(self, now: float, s: Settings, cam_ok: bool, model_ok: bool, raw: Optional[str]) -> list[dict]:
        ev: list[dict] = []
        if not (cam_ok and model_ok):
            fault = "camera_unavailable" if not cam_ok else "model_error"
            if self._fault != fault:
                self.reset_evidence()          # drop all vacancy progress; faults never become vacancy
                self._fault = fault
            self.state, self.last_t = fault, now
            return ev
        if self._fault:                        # just recovered: distrust the first seconds
            self._fault, self._recover_until = None, now + s.recovery_grace_s
        if now < self._recover_until:
            self.state, self.last_t = "transitioning", now
            return ev

        dt = 0.0 if self.last_t is None else min(now - self.last_t, 1.0)
        self.last_t = now
        if raw in ("occupied", "vacant"):
            a = 1 - math.exp(-dt / s.smoothing_tau_s)
            self.ema += a * ((1.0 if raw == "occupied" else 0.0) - self.ema)
            self.uncertain_since = None
            self.uncertain_warned = False
        elif raw == "uncertain" and self.uncertain_since is None:
            self.uncertain_since = now

        target = "occupied" if self.ema >= s.enter_occupied else "vacant" if self.ema <= s.exit_occupied else None
        if target and target != self.stable:
            if self.cross_target != target:
                self.cross_target, self.cross_since = target, now
            elif now - self.cross_since >= s.confirm_s:
                prev, self.stable, self.cross_target = self.stable, target, None
                if target == "vacant":
                    self.episode += 1
                    self.alerted_at = None
                ev.append({"type": "seat_vacant" if target == "vacant" else "seat_occupied",
                           "severity": "info", "message": f"Seat {target}", "prev": prev})
        else:
            self.cross_target = None

        if raw in ("occupied", "vacant") and self.stable and raw != self.stable:
            self.disagree_since = self.disagree_since or now
        elif raw in ("occupied", "vacant"):
            self.disagree_since = None

        if self.stable is None:
            rep = "transitioning"
        elif self.uncertain_since is not None and now - self.uncertain_since >= s.uncertain_hold_s:
            rep = "uncertain"
        elif self.disagree_since is not None and now - self.disagree_since >= s.show_transition_s:
            rep = "transitioning"
        else:
            rep = self.stable
        self.state = rep

        if rep == "vacant":
            self.vacant_since = self.vacant_since if self.vacant_since is not None else now
        else:
            self.vacant_since = None           # any non-vacant state restarts the confirmation clock

        if rep == "uncertain" and not self.uncertain_warned and self.uncertain_since is not None \
                and now - self.uncertain_since >= s.uncertain_warn_seconds:
            self.uncertain_warned = True
            ev.append({"type": "seat_uncertain", "severity": "warning",
                       "message": f"Uncertain for {s.uncertain_warn_seconds:.0f}s"})

        if rep == "vacant" and self.vacant_for(now) >= s.vacancy_seconds and \
                (self.alerted_at is None or now - self.alerted_at >= s.cooldown_seconds):
            self.alerted_at = now
            ev.append({"type": "vacancy_confirmed", "severity": "critical",
                       "message": f"Seat vacant for {self.vacant_for(now):.0f} s (threshold {s.vacancy_seconds:.0f} s)",
                       "vacant_duration_s": round(self.vacant_for(now), 1), "episode_id": f"ep_{self.episode}"})
        return ev


# ───────────────────────────── camera layer ─────────────────────────────
@dataclass
class Frame:
    image: np.ndarray
    frame_id: int
    t_mono: float


@dataclass
class SourceSpec:
    type: str = "synthetic"      # usb | rtsp | http_mjpeg | file | synthetic
    usb_index: int = 0
    url: str = ""
    path: str = ""
    loop: bool = True
    target_fps: float = 15.0
    resolution: Optional[tuple[int, int]] = None


def mask_url(u: str) -> str:
    import re
    return re.sub(r"(://[^:/@]+):[^@]*@", r"\1:***@", u)


def run_with_deadline(fn: Callable[[], Any], seconds: float) -> Any:
    """Open calls on RTSP can hang: run in a daemon thread and give up after `seconds`."""
    box: dict[str, Any] = {}
    t = threading.Thread(target=lambda: box.setdefault("r", fn()), daemon=True)
    t.start(); t.join(seconds)
    if t.is_alive():
        raise TimeoutError("open timed out")
    return box.get("r")


class SyntheticSource:
    """Scripted scene (desk, chair, orange 'person' who sits and leaves). Known ground truth for tests."""
    def __init__(self, present_s=12.0, absent_s=14.0, fps=15.0, size=(640, 360), noise=3.0, start_present=True):
        self.present_s, self.absent_s, self.fps, self.size, self.noise = present_s, absent_s, fps, size, noise
        self.start_present = start_present
        self.t_start = time.monotonic(); self._next = self.t_start
        self.rng = np.random.default_rng(7)

    def person_present(self, t: Optional[float] = None) -> bool:
        t = (time.monotonic() - self.t_start) if t is None else t
        phase = t % (self.present_s + self.absent_s)
        return phase < self.present_s if self.start_present else phase >= self.absent_s

    def open(self): return None
    def close(self): ...

    def read(self) -> Optional[np.ndarray]:
        self._next += 1 / self.fps
        time.sleep(max(0.0, self._next - time.monotonic()))
        w, h = self.size
        img = np.full((h, w, 3), (95, 105, 100), np.uint8)                       # floor
        cv2.rectangle(img, (int(.05 * w), int(.18 * h)), (int(.95 * w), int(.30 * h)), (60, 70, 85), -1)  # desk
        cv2.rectangle(img, (int(.34 * w), int(.55 * h)), (int(.50 * w), int(.80 * h)), (120, 90, 70), -1)  # chair
        cv2.rectangle(img, (int(.34 * w), int(.34 * h)), (int(.50 * w), int(.58 * h)), (120, 90, 70), -1)  # backrest
        if self.person_present():
            cv2.rectangle(img, (int(.35 * w), int(.40 * h)), (int(.49 * w), int(.72 * h)), (30, 120, 240), -1)
            cv2.circle(img, (int(.42 * w), int(.33 * h)), int(.045 * h * 2), (40, 140, 250), -1)
        noise = self.rng.normal(0, self.noise, img.shape)
        return np.clip(img + noise, 0, 255).astype(np.uint8)


class CvSource:
    def __init__(self, spec: SourceSpec):
        self.spec, self.cap = spec, None
        self._pace = 1 / max(1.0, spec.target_fps); self._next = time.monotonic()

    def open(self):
        sp = self.spec
        if sp.type == "usb":
            order = {"win32": [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY], "darwin": [cv2.CAP_AVFOUNDATION, cv2.CAP_ANY]
                     }.get(sys.platform, [cv2.CAP_V4L2, cv2.CAP_ANY])
            for be in order:
                cap = cv2.VideoCapture(sp.usb_index, be)
                if cap.isOpened():
                    if sp.resolution:
                        cap.set(cv2.CAP_PROP_FRAME_WIDTH, sp.resolution[0]); cap.set(cv2.CAP_PROP_FRAME_HEIGHT, sp.resolution[1])
                    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG")); cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                    self.cap = cap
                    for _ in range(8): cap.read()                  # discard auto-exposure warm-up
                    return
                cap.release()
            raise ApiError("SOURCE_NOT_FOUND", f"No USB camera at index {sp.usb_index}",
                           "Check cable/permissions and that no other app is using the camera", retryable=True)
        if sp.type == "file":
            if not os.path.isfile(sp.path):
                raise ApiError("SOURCE_NOT_FOUND", f"File not found: {sp.path}")
            self.cap = cv2.VideoCapture(sp.path)
            fps = self.cap.get(cv2.CAP_PROP_FPS) or sp.target_fps
            self._pace = 1 / max(1.0, min(fps, 60))
        else:  # rtsp / http_mjpeg
            self.cap = run_with_deadline(lambda: cv2.VideoCapture(sp.url, cv2.CAP_FFMPEG), 8.0)
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not self.cap or not self.cap.isOpened():
            raise ApiError("SOURCE_CONNECT_FAILED", f"Could not open {mask_url(sp.url or sp.path)}",
                           "Check URL, credentials, network; try the camera's sub-stream (H.264)", retryable=True)

    def read(self):
        if self.spec.type == "file":
            self._next += self._pace
            time.sleep(max(0.0, self._next - time.monotonic()))
        ok, img = self.cap.read()
        if not ok and self.spec.type == "file" and self.spec.loop:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0); ok, img = self.cap.read()
        return img if ok else None

    def close(self):
        if self.cap is not None: self.cap.release()


def frame_valid(img: Optional[np.ndarray]) -> bool:
    if img is None or img.ndim != 3 or img.size == 0:
        return False
    return float(img[::8, ::8].std()) > 0.5      # all-black/constant frames are a failure signature, not an empty room


def render_no_signal(size=(640, 360), text="NO SIGNAL") -> bytes:
    img = np.full((size[1], size[0], 3), 24, np.uint8)
    cv2.putText(img, text, (size[0] // 2 - 110, size[1] // 2), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (150, 150, 150), 2)
    return cv2.imencode(".jpg", img)[1].tobytes()


class CameraManager:
    def __init__(self):
        self.spec: Optional[SourceSpec] = None
        self.state, self.last_error = "disconnected", None
        self.frame_size: Optional[tuple[int, int]] = None
        self.dropped_invalid = 0
        self._frame: Optional[Frame] = None; self._jpeg: Optional[bytes] = None; self._jpeg_id = 0
        self._lock = threading.Lock(); self._stop = threading.Event(); self._thread: Optional[threading.Thread] = None
        self._fid = 0
        self.synthetic: Optional[SyntheticSource] = None
        self.capture_ts: collections.deque = collections.deque(maxlen=60)

    def start(self, spec: SourceSpec) -> None:
        self.stop()
        self.spec, self.state, self.last_error, self._frame, self._jpeg = spec, "connecting", None, None, None
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="capture", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)
            if self._thread.is_alive(): log.warning("capture thread did not exit in 3s (blocked read)")
        self._thread, self.state, self._frame = None, "disconnected", None

    def latest(self) -> Optional[Frame]:
        with self._lock: return self._frame

    def frame_age(self) -> Optional[float]:
        f = self.latest()
        return None if f is None else time.monotonic() - f.t_mono

    def jpeg(self) -> tuple[Optional[bytes], int]:
        with self._lock: return self._jpeg, self._jpeg_id

    def capture_fps(self) -> Optional[float]:
        ts = list(self.capture_ts)
        return None if len(ts) < 5 or ts[-1] == ts[0] else round((len(ts) - 1) / (ts[-1] - ts[0]), 1)

    def _make_source(self):
        sp = self.spec
        if sp.type == "synthetic":
            self.synthetic = SyntheticSource(fps=sp.target_fps)
            return self.synthetic
        return CvSource(sp)

    def _run(self):
        backoff, last_jpeg = 0.5, 0.0
        while not self._stop.is_set():
            src = self._make_source()
            try:
                src.open()
            except ApiError as e:
                self.state, self.last_error = "reconnecting", {"code": e.code, "message": e.message, "hint": e.hint}
                src.close()
                if e.code == "SOURCE_NOT_FOUND" and self.spec.type == "file":
                    self.state = "disconnected"; return
                self._stop.wait(backoff + random.random() * 0.3); backoff = min(backoff * 2, 10); continue
            except Exception as e:                                   # noqa: BLE001
                self.state, self.last_error = "reconnecting", {"code": "SOURCE_CONNECT_FAILED", "message": str(e), "hint": ""}
                src.close(); self._stop.wait(backoff); backoff = min(backoff * 2, 10); continue
            self.state, self.last_error, backoff, fails = "connected", None, 0.5, 0
            while not self._stop.is_set():
                img = src.read()
                if img is None:
                    fails += 1
                    if self.spec.type == "file" and not self.spec.loop:
                        self.state = "disconnected"; self.last_error = {"code": "source_ended", "message": "Video ended", "hint": ""}
                        src.close(); return
                    if fails >= 5: break                              # drop to reconnect
                    time.sleep(0.05); continue
                if not frame_valid(img):
                    self.dropped_invalid += 1; continue
                fails = 0; self._fid += 1; now = time.monotonic()
                self.frame_size = (img.shape[1], img.shape[0])
                with self._lock: self._frame = Frame(img, self._fid, now)
                self.capture_ts.append(now)
                if now - last_jpeg >= 1 / 15:                          # preview encode capped at 15 fps
                    last_jpeg = now
                    prev = img if img.shape[1] <= 960 else cv2.resize(img, (960, int(img.shape[0] * 960 / img.shape[1])))
                    ok, buf = cv2.imencode(".jpg", prev, [cv2.IMWRITE_JPEG_QUALITY, 75])
                    if ok:
                        with self._lock: self._jpeg, self._jpeg_id = buf.tobytes(), self._fid
            src.close()
            if not self._stop.is_set():
                self.state = "reconnecting"
                self._stop.wait(backoff); backoff = min(backoff * 2, 10)
        src.close()


# ───────────────────────────── metrics + hub ─────────────────────────────
def pct(vals, p) -> Optional[float]:
    return round(float(np.percentile(vals, p)), 1) if len(vals) >= 3 else None


class Hub:
    """Thread-safe publish. Events/state changes are queued (never dropped);
    high-rate messages (inference/metrics/health) keep only the newest per key."""
    class Chan:
        def __init__(self):
            self.queue: collections.deque = collections.deque(maxlen=500)
            self.latest: dict[Any, dict] = {}
            self.wake = None  # asyncio.Event

    def __init__(self):
        self.loop, self.chans = None, set()

    def publish(self, msg: dict, key: Any = None) -> None:
        if self.loop is None: return
        self.loop.call_soon_threadsafe(self._fan, msg, key)

    def _fan(self, msg, key):
        for c in list(self.chans):
            (c.latest.__setitem__(key, msg) if key is not None else c.queue.append(msg))
            c.wake.set()


# ───────────────────────────── runtime: ties everything together ─────────────────────────────
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
        self.acked: set[str] = set(); self.snooze_until: dict[str, float] = {}
        self._cam_fault = False; self._eid = 0; self._aid = 0
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
        ok = self.model_state == "ready" and self.camera.state == "connected"
        return {"status": "ok" if ok else "degraded", "backend_version": BACKEND_VERSION, "contract_version": CONTRACT_VERSION,
                "uptime_s": round(time.monotonic() - self.t0, 1), "simulated": self.simulated,
                "camera": {"state": self.camera.state, "last_frame_age_ms": None if age is None else int(age * 1000),
                           "message": (self.camera.last_error or {}).get("message")},
                "model": {"state": self.model_state, "name": self.adapter.name, "message": self.model_msg}}

    def seat_status(self) -> list[dict]:
        now = time.monotonic()
        return [{"seat_id": x.seat_id, "name": x.name, "state": x.tracker.state, "confidence": x.tracker.confidence,
                 "vacant_for_s": round(x.tracker.vacant_for(now), 1), "polygon": x.polygon, "enabled": x.enabled}
                for x in self.seats.values()]

    def metrics(self) -> dict:
        ts = list(self.proc_ts)
        fps = None if len(ts) < 3 or ts[-1] == ts[0] else round((len(ts) - 1) / (ts[-1] - ts[0]), 1)
        return {"capture_fps": self.camera.capture_fps(), "processing_fps": fps,
                "inference_ms": {"p50": pct(self.lat, 50), "p95": pct(self.lat, 95), "p99": pct(self.lat, 99),
                                 "last": round(self.lat[-1], 1) if self.lat else None},
                "pipeline_ms": {"p50": pct(self.pipe, 50), "p95": pct(self.pipe, 95)},
                "dropped_frames": self.camera.dropped_invalid, "inference_errors": self.inference_errors,
                "confidence_hist": {"bins": [round(i / 10, 1) for i in range(11)], "counts": self.conf_hist.tolist()},
                "device": self.adapter.device, "simulated": self.simulated}

    # ---- the pipeline loop (10 Hz tick; inference when due; staleness judged by frame age)
    def _loop(self):
        last_infer = last_metrics = last_health = 0.0
        while not self._stop.wait(0.1):
            try:
                self._tick(last_infer, last_metrics, last_health)
                now = time.monotonic()
                if now - last_infer >= 1 / self.s.target_inference_fps: last_infer = now
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
        if not cam_ok and not self._cam_fault:
            self._cam_fault = True
            self.emit("camera_unavailable", "warning", (self.camera.last_error or {}).get("message") or "No valid frames")
            self.hub.publish({"type": "health", "ts": _iso(), "data": self.health()}, "health")
        elif cam_ok and self._cam_fault:
            self._cam_fault = False; self.emit("camera_recovered", "info", "Frames resumed")
        due = now - last_infer >= 1 / s.target_inference_fps
        for seat in list(self.seats.values()):
            if not seat.enabled: continue
            raw, obs = None, None
            if cam_ok and due and fr.frame_id != seat.last_fid and self.model_state == "ready":
                seat.last_fid = fr.frame_id
                try:
                    t0 = time.perf_counter()
                    crop = make_crop(fr.image, seat.polygon, s.crop_padding)
                    t1 = time.perf_counter()
                    boxes, scores = self.adapter.infer(crop.img)
                    inf_ms = (time.perf_counter() - t1) * 1000
                    obs = decide(boxes, scores, crop, s); obs.inference_ms = inf_ms
                    raw, seat.infer_failed = obs.raw, False
                    self.lat.append(inf_ms); self.pipe.append((time.monotonic() - fr.t_mono) * 1000); self.proc_ts.append(now)
                    self.conf_hist[min(9, int(obs.person_conf * 10))] += 1
                except Exception as e:                                # noqa: BLE001
                    seat.infer_failed = True; self.inference_errors += 1
                    if now - self._err_last > 10:                      # rate-limited
                        self._err_last = now; self.emit("inference_error", "warning", f"{type(e).__name__}: {e}", seat.seat_id)
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


def _iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ───────────────────────────── web layer (FastAPI imported lazily) ─────────────────────────────
class SourceReq(BaseModel):
    type: str; usb_index: int = 0; url: str = ""; path: str = ""; loop: bool = True
    target_fps: float = 15; resolution: Optional[list[int]] = None


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
                "checkpoint": a.checkpoint, "license": a.license, "simulated": a.simulated, "mode": "roi_crop"}

    @app.get(f"{P}/system/metrics")
    def metrics(): return rt.metrics()

    @app.post(f"{P}/sources/select")
    def select(req: SourceReq):
        if req.type not in ("usb", "rtsp", "http_mjpeg", "file", "synthetic"):
            raise ApiError("SOURCE_NOT_FOUND", f"Unknown source type {req.type}", status=422)
        rt.camera.start(SourceSpec(req.type, req.usb_index, req.url, req.path, req.loop, req.target_fps,
                                   tuple(req.resolution) if req.resolution else None))
        return {"camera_id": "cam0", "state": rt.camera.state, "frame_size": rt.camera.frame_size}

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
                if live and jpg and jid != last: last, out = jid, jpg
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
def parse_source(arg: str) -> SourceSpec:
    if arg == "synthetic": return SourceSpec("synthetic")
    if arg.startswith("usb:"): return SourceSpec("usb", usb_index=int(arg[4:]))
    if arg.startswith("rtsp"): return SourceSpec("rtsp", url=arg)
    if arg.startswith("http"): return SourceSpec("http_mjpeg", url=arg)
    return SourceSpec("file", path=arg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", action="store_true", help="synthetic source + simulated detector (flagged simulated)")
    ap.add_argument("--source", default=os.getenv("SOURCE", "synthetic"))
    ap.add_argument("--model-backend", default=os.getenv("MODEL_BACKEND", "ultralytics"), choices=["ultralytics", "sim"])
    ap.add_argument("--model-path", default=os.getenv("MODEL_PATH", "weights/yolo26n.pt"))
    ap.add_argument("--device", default=os.getenv("DEVICE", "auto"))
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    adapter = SimulatedBlobAdapter() if (a.demo or a.model_backend == "sim") else YoloAdapter(a.model_path, a.device)
    rt = Runtime(Settings(), adapter, demo=a.demo)
    rt.upsert_seat("seat-1", "Demo seat", DEMO_POLY)
    import uvicorn
    uvicorn.run(create_app(rt, parse_source("synthetic" if a.demo else a.source)),
                host=a.host, port=a.port, workers=1, reload=False)       # 1 worker, no reload: one camera owner


if __name__ == "__main__":
    main()