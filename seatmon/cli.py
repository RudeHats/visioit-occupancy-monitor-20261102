"""Command-line bootstrap. One backend process owns each camera."""
import argparse, logging, os
from .config import Settings
from .camera import SourceSpec
from .models import SimulatedBlobAdapter, YoloAdapter
from .runtime import Runtime, DEMO_POLY
from .web import create_app

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
