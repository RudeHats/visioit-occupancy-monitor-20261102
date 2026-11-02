"""Source adapters, bounded latest-frame capture, and reconnection."""
import collections, logging, os, random, shutil, subprocess, sys, threading, time
from urllib.parse import urlparse
from dataclasses import dataclass
from typing import Any, Callable, Optional
import cv2
import numpy as np
from .config import ApiError
log = logging.getLogger("seatmon.camera")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000|fflags;nobuffer|flags;low_delay")
cv2.setNumThreads(1)

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
            parsed = urlparse(sp.url)
            expected = "rtsp" if sp.type == "rtsp" else "http"
            if parsed.scheme.lower() != expected or not parsed.netloc:
                raise ApiError("SOURCE_INVALID", f"Invalid {sp.type} URL: {mask_url(sp.url)}",
                               "Provide a complete URL including host and stream path", status=422)
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


def ffmpeg_executable():
    executable = shutil.which("ffmpeg")
    if executable: return executable
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        return None


class FfmpegGatewaySource:
    """Normalize RTSP to JPEG frames for browser preview and inference.

    FFmpeg is optional. When present this avoids OpenCV codec/transport differences;
    callers fall back to CvSource when it is not installed.
    """
    def __init__(self, spec: SourceSpec):
        self.spec, self.proc, self.buffer = spec, None, bytearray()
        self.backend = "ffmpeg_gateway"

    def open(self):
        exe = ffmpeg_executable()
        if not exe:
            raise ApiError("GATEWAY_UNAVAILABLE", "FFmpeg gateway is not installed",
                           "Install FFmpeg or use an OpenCV build with FFmpeg", retryable=True)
        self.proc = subprocess.Popen([exe, "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
                                      "-timeout", "5000000", "-i", self.spec.url, "-an", "-vf", f"fps={max(1, min(30, self.spec.target_fps))}",
                                      "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "5", "pipe:1"],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)

    def read(self):
        if not self.proc or not self.proc.stdout: return None
        while True:
            start = self.buffer.find(b"\xff\xd8"); end = self.buffer.find(b"\xff\xd9", start + 2)
            if start >= 0 and end >= 0: break
            chunk = self.proc.stdout.read(32768)
            if not chunk: return None
            self.buffer.extend(chunk)
            if len(self.buffer) > 2_000_000: self.buffer.clear()
        jpg = bytes(self.buffer[start:end + 2]); del self.buffer[:end + 2]
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        return img if img is not None else None

    def close(self):
        if self.proc:
            self.proc.kill()
            self.proc.wait(timeout=1)
            self.proc = None


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
        self.backend = "none"
        self.capture_ts: collections.deque = collections.deque(maxlen=60)

    def start(self, spec: SourceSpec) -> None:
        if self.spec == spec and self._thread and self._thread.is_alive():
            return
        self.stop()
        if self._thread and self._thread.is_alive():
            raise ApiError("SOURCE_BUSY", "Previous camera is still closing", "Retry in a few seconds", status=409, retryable=True)
        self.spec, self.state, self.last_error, self._frame, self._jpeg = spec, "connecting", None, None, None
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="capture", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)
            if self._thread.is_alive(): log.warning("capture thread did not exit in 3s (blocked read)")
        if not self._thread or not self._thread.is_alive(): self._thread = None
        self.state, self._frame = "disconnected", None

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
            # Keep the public app.py compatibility seam used by deterministic tests.
            legacy = sys.modules.get("app")
            source_class = getattr(legacy, "SyntheticSource", SyntheticSource)
            self.synthetic = source_class(fps=sp.target_fps)
            return self.synthetic
        if sp.type == "rtsp" and ffmpeg_executable():
            return FfmpegGatewaySource(sp)
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
            self.backend = getattr(src, "backend", "opencv_ffmpeg")
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
