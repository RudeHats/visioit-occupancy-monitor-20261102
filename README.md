# VisioIt — Smart Vacant-Seat Monitoring

Live demo: real YOLO occupancy model + FastAPI backend + Next.js frontend.

## What runs

| Component | Port | Tech |
|-----------|------|------|
| Backend | `http://localhost:8000` | FastAPI + Uvicorn + OpenCV + Ultralytics YOLO |
| Frontend | `http://localhost:3000` | Next.js + React + Tailwind |

## Prerequisites

- Python 3.11+
- Node.js 20+ (pnpm)
- Internet access (one-time, to download YOLO weights)

## Quick start (3 commands)

### Terminal 1 — Backend (real YOLO model, auto-detected hardware)

```bash
cd /home/gaurav/Desktop/Empty/VisioIt
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py --demo
```

The backend auto-selects the best available compute: **GPU (CUDA) → NPU → Apple MPS → CPU**.  
The selected device is reported honestly via `GET /api/v1/system/model`.

### Terminal 2 — Frontend

```bash
cd /home/gaurav/Desktop/Empty/VisioIt/Front-End
pnpm install        # (first time only)
pnpm dev
```

## View the demo

Open **http://localhost:3000/live** — you'll see:

- **Live MJPEG stream** from the backend camera source with ROI overlay
- **Real-time seat state** (occupied / vacant / uncertain / transitioning) from YOLO inference
- **Metrics**: inference latency p50/p95/p99, FPS, dropped frames
- **Vacancy alert** banner when a seat stays vacant past the threshold
- **SIMULATED** badge whenever synthetic data is used (demo mode)

Other pages:
- `/` — Overview: KPIs, seat grid, recent events, system health
- `/events` — Event history with acknowledge / snooze
- `/settings` — Camera source, vacancy duration, confidence thresholds, alert sound
- `/system` — Model metadata (name, version, device, license), latency/FPS charts

## Use a real camera or video file

Replace the synthetic source with any source the host can decode:

```bash
# USB camera (index 0)
python app.py --source usb:0

# RTSP stream
python app.py --source rtsp://user:pass@192.168.1.10:554/stream1

# Video file (looped)
python app.py --source /path/to/video.mp4

# HTTP MJPEG
python app.py --source http://host/video.mjpg
```

With a real source, every payload carries `simulated: false` and the YOLO model performs real person detection.

## Hardware selection

Device priority (auto-detected):
1. **NVIDIA GPU** (CUDA) — if `nvidia-smi` reports a GPU and torch CUDA wheels are installed
2. **NPU** — if `torch.backends.npu` is available
3. **Apple MPS** — on Apple Silicon
4. **CPU** — fallback, always works

Override manually:
```bash
python app.py --demo --device cuda:0   # force CUDA
python app.py --demo --device cpu       # force CPU
```

The active device and model are shown in `/api/v1/system/model` and on the `/system` page.

## Licence

Ultralytics YOLO weights and code are **AGPL-3.0** (Enterprise licence for commercial use).  
Demoing locally is fine; shipping commercially needs the Enterprise licence, AGPL compliance, or a permissive-licence detector path.

## Honesty

- Accuracy is **not validated** on your footage — evaluate before relying on alerts for safety-critical use.
- Camera failure is never reported as vacancy (the most important invariant).
- Simulated data is always visibly badged `SIMULATED`.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `ImportError: libcublas` | Reinstall torch CPU: `pip install torch --index-url https://download.pytorch.org/whl/cpu` |
| Model downloads every run | Weights are fetched once into `weights/` and loaded by path at runtime |
| Camera "busy" | Only one backend process at a time (`workers=1`, `reload=False`) |
| WebSocket 403 | Backend CORS allows `http://localhost:3000` and `http://127.0.0.1:3000` |
| Frontend shows offline | Set `NEXT_PUBLIC_USE_MOCK=false` and ensure backend is on `:8000` |
