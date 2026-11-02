"""Bounded telemetry histories and thread-safe event fanout."""
import collections, time
from typing import Any, Optional
import numpy as np

def hardware_info(device: str) -> dict:
    """Return observable accelerator facts without claiming system-wide utilization."""
    info = {"device": device, "accelerator": device.split(":", 1)[0], "memory_allocated_mb": None,
            "memory_reserved_mb": None, "utilization_percent": None, "utilization_source": None}
    if not device.startswith("cuda"):
        return info
    try:
        import torch
        if not torch.cuda.is_available():
            return info
        idx = int(device.split(":", 1)[1]) if ":" in device else 0
        info.update({"name": torch.cuda.get_device_name(idx),
                     "memory_allocated_mb": round(torch.cuda.memory_allocated(idx) / 1048576, 1),
                     "memory_reserved_mb": round(torch.cuda.memory_reserved(idx) / 1048576, 1),
                     "utilization_source": "torch_memory_only"})
    except Exception as exc:  # telemetry must never affect inference
        info["error"] = type(exc).__name__
    return info


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

def _iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
