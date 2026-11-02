"""Model adapters and compute device selection."""
import os, threading
import cv2
import numpy as np

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

    def infer_batch(self, images):
        return [self.infer(image) for image in images]


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
        self._lock = threading.Lock()

    def load(self) -> None:
        import torch
        from ultralytics import YOLO  # lazy: core must import without it
        self.device = pick_device(self._dev_pref)     # GPU -> NPU -> Apple MPS -> CPU
        torch.set_num_threads(max(1, min(8, (os.cpu_count() or 4) // 2)))
        self._m = YOLO(self.checkpoint)                      # load by LOCAL path
        if self._m.names.get(0) != "person":
            raise RuntimeError(f"Unexpected class map: {self._m.names.get(0)!r} (expected 'person')")
        self.version = getattr(__import__("ultralytics"), "__version__", "?")
        self._half = self.device.startswith("cuda")
        from ultralytics.cfg import DEFAULT_CFG_DICT
        self._precision = {"quantize": 16 if self._half else 32} if "quantize" in DEFAULT_CFG_DICT else {"half": self._half}
        if self._half:
            torch.backends.cudnn.benchmark = True
        for _ in range(3):                                   # warm-up (first call is slow)
            self._m.predict(np.zeros((640, 640, 3), np.uint8), device=self.device, verbose=False, **self._precision)

    def infer(self, bgr):
        return self.infer_batch([bgr])[0]

    def infer_batch(self, images):
        import torch
        with self._lock, torch.inference_mode():
            results = self._m.predict(images, imgsz=640, conf=0.15, classes=[0], device=self.device,
                                      verbose=False, **self._precision)
            return [(r.boxes.xyxy.cpu().numpy().astype(np.float32), r.boxes.conf.cpu().numpy().astype(np.float32)) for r in results]

    def discover_seats(self, image):
        """Chair proposals only; occupancy still requires persistent configured ROIs."""
        import torch
        with self._lock, torch.inference_mode():
            result = self._m.predict(image, imgsz=960, conf=.3, classes=[56], device=self.device,
                                     verbose=False, **self._precision)[0]
            return result.boxes.xyxy.cpu().numpy(), result.boxes.conf.cpu().numpy()


# ───────────────────────────── per-frame decision ─────────────────────────────
