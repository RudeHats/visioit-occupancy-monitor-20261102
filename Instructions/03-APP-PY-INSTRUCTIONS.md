# 03: `app.py` Build Instructions (Environment · Packages · Exact Models · Hardening)

**Audience:** the backend coding agent. **Companion docs:** `INTEGRATION-INSTRUCTIONS.md` (API contract), `04-CAMERA-COMPATIBILITY.md` (camera layer), `02-BACKEND-AGENT-PROMPT.md` (working style). This file is the **concrete "how"**: exact interpreter, install order, exact model checkpoints, load code, `app.py` startup sequence, and a bug playbook.

**Fact-check status (as of 28 Oct 2026).** Verified from official pages: YOLO26 checkpoints and names (`yolo26n.pt`, `yolo26s.pt`, `yolo26n-pose.pt`…), Ultralytics dual licence (AGPL-3.0 / Enterprise), `PekingU/rtdetr_r50vd` is Apache-2.0 and loads via `transformers`, and PyTorch 2.15 has a minimum of Python 3.11 (3.10 reaches end of life on 31 Oct 2026). Everything marked **VERIFY** must be re-checked by you at build time, so don't trust this file blindly for those items.

---

## 0. Decisions (don't re-litigate, just implement)

| Decision | Choice | Why |
|---|---|---|
| Python | **3.12** (3.11 is the floor, never 3.10 or older) | Supported by current PyTorch and all dependencies, and 3.10 is end-of-life |
| Isolation | `backend/.venv` | No global installs |
| Primary model | **`yolo26n.pt`**, COCO person detector, CPU/GPU/MPS | Smallest current Ultralytics detector, NMS-free end-to-end output, and quick on CPU |
| Accuracy upgrade | **`yolo26s.pt`** (config switch) | Use when `n` misses people in the benchmark |
| Optional "seated" signal | **`yolo26n-pose.pt`** | Hip/knee keypoints inside the ROI refine occupied vs. passing-by |
| Permissive-licence fallback | **`PekingU/rtdetr_r50vd`** via `transformers` (Apache-2.0, verified) | Lets the product ship without the AGPL obligation. Heavier (~42M params), so expect it to need a GPU or run slower on CPU |
| Not used | Any ImageNet classifier as the decision model | It has no occupied/vacant class and training is out of scope |
| Optional benchmark | Zero-shot image-text model on the crop | Only as candidate **D**, never the default |
| Server | Uvicorn, **1 worker**, no `--reload` in run mode | In-memory state and one camera owner |
| Config | `pydantic-settings` + `.env` | Typed, validated |

**Licence reality (tell the user in the final report):** Ultralytics YOLO weights and code are AGPL-3.0, with an Enterprise licence for commercial products. Demoing locally is fine, but shipping or hosting it commercially needs either the Enterprise licence, AGPL compliance, or the Apache-2.0 RT-DETR path. Implement both adapters so the choice is a config flag (`MODEL_BACKEND=ultralytics|rtdetr`).

---

## 1. Preflight (run and print before installing anything)
```
python --version            # need 3.11 or 3.12; if not, install 3.12 (py launcher / pyenv / brew / apt)
nvidia-smi                  # NVIDIA GPU + driver? (Windows/Linux)
uname -m / platform info    # arm64 Mac → use MPS; x86_64 → CPU/CUDA
ffmpeg -version             # optional, only for debugging cameras
```
Decide `ACCEL` ∈ {`cpu`, `cuda`, `mps`} and write it in `backend/README.md`. If an NVIDIA GPU is present, **note the driver's supported CUDA version** (top-right of `nvidia-smi`).

## 2. Environment setup (order matters)

### 2.1 Create and activate the venv
```bash
# macOS / Linux
cd backend && python3.12 -m venv .venv && source .venv/bin/activate
# Windows PowerShell
cd backend; py -3.12 -m venv .venv; .\.venv\Scripts\Activate.ps1
# (if scripts are blocked: Set-ExecutionPolicy -Scope Process Bypass)
python -m pip install -U pip setuptools wheel
```

### 2.2 Install PyTorch FIRST, with the right build
Open the official selector (`https://pytorch.org/get-started/locally/`) logic and use its exact command. **VERIFY** the current CUDA tags, since they change between releases (recent ones include `cu126`, `cu128`, `cu130`).
```bash
# CPU only (Windows/Linux)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
# NVIDIA GPU (replace cuXXX with a tag your driver supports, from the selector)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cuXXX
# macOS (Apple Silicon or Intel): plain PyPI wheels include MPS
pip install torch torchvision
```
Rules:
- Newest GPUs (for example the RTX 50 series) need a recent CUDA build. A "no kernel image is available" error means the wheel is too old, so move to a newer `cuXXX` or fall back to CPU. **Don't loop**: try at most two CUDA tags, then use CPU and log it.
- If the corporate network blocks the index, fall back to PyPI CPU wheels and report it.

### 2.3 Install the rest
`backend/requirements.txt` (direct dependencies only, no versions at first):
```
fastapi
uvicorn[standard]
pydantic>=2
pydantic-settings
numpy
ultralytics
httpx
psutil
python-multipart
pytest
pytest-asyncio
```
`backend/requirements-permissive.txt` (only for the Apache-2.0 path):
```
transformers
safetensors
huggingface_hub
```
```bash
pip install -r requirements.txt
pip install -r requirements-permissive.txt     # optional but recommended so both adapters are testable
```

### 2.4 OpenCV, avoiding the #1 environment bug
`ultralytics` pulls in the GUI build `opencv-python`. Having both `opencv-python` and `opencv-python-headless` installed makes `cv2` import unpredictable. A server doesn't need GUI windows, so keep **only headless**:
```bash
pip uninstall -y opencv-python opencv-python-headless
pip install opencv-python-headless
python - <<'EOF'
import importlib.metadata as m
dists = {d.metadata["Name"].lower() for d in m.distributions()}
bad = {"opencv-python","opencv-contrib-python"} & dists
assert not bad, f"Duplicate OpenCV builds: {bad}"
import cv2; print("cv2", cv2.__version__)
info = cv2.getBuildInformation()
print([l.strip() for l in info.splitlines() if "FFMPEG" in l or "GStreamer" in l])
EOF
```
Never call `cv2.imshow` in backend code. If `FFMPEG: NO` appears, RTSP and many video files will fail, so report it and install a wheel that includes FFmpeg (the standard PyPI wheels do).

### 2.5 Freeze for reproducibility
```bash
pip freeze > requirements.lock.txt     # commit it; "pip install -r requirements.lock.txt" reproduces the env
```
Install torch separately in the README (the lock holds the `+cpu`/`+cuXXX` tag, and the index URL must be given).

### 2.6 Threading hygiene (put at the top of `app.py`, before heavy imports)
```python
import os
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS",
    "rtsp_transport;tcp|stimeout;5000000|fflags;nobuffer|flags;low_delay")
import cv2, torch
cv2.setNumThreads(1)                       # avoid fighting torch for cores
torch.set_num_threads(min(4, os.cpu_count() or 4))
```

## 3. Models: exact files and how to load them

### 3.1 Layout
```
backend/weights/
  yolo26n.pt            # primary
  yolo26s.pt            # optional accuracy upgrade
  yolo26n-pose.pt       # optional seated heuristic
  rtdetr_r50vd/         # HF snapshot (permissive path)
  MODELS.lock.json      # name, source URL, sha256, size, licence, date downloaded, task, classes
```

### 3.2 One-time fetch script `scripts/fetch_models.py` (network needed only here)
- **Ultralytics:** `YOLO("yolo26n.pt")` downloads on first use *into the current directory* and from the latest Ultralytics release. Run the fetch with `cwd=weights/` (or move the file), then load **by path** at runtime. If the name does not resolve (the project renamed or retired it), list what the installed `ultralytics` version supports, say which checkpoint you used instead, and write it in `MODELS.lock.json`. **Never silently substitute an older model.**
- **RT-DETR:**
  ```python
  from huggingface_hub import snapshot_download
  p = snapshot_download("PekingU/rtdetr_r50vd", local_dir="weights/rtdetr_r50vd")
  ```
  Record the commit hash in the lock file and **VERIFY** the licence on the model card (verified Apache-2.0 for `rtdetr_r50vd`). If you add `rtdetr_r18vd` or other variants, verify each card separately.
- After fetching, compute `sha256` for each file and write `MODELS.lock.json`. At startup, verify the hash and **refuse to start with the real model if it mismatches**. Fall back to demo/simulated only when `--demo` is set.
- Runtime is offline-safe: after fetching set `HF_HUB_OFFLINE=1` and load only from local paths.

### 3.3 Device selection (one function, used everywhere)
```python
def pick_device(pref: str = "auto") -> str:
    if pref != "auto": return pref
    if torch.cuda.is_available(): return "cuda:0"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available(): return "mps"
    return "cpu"
```
Use FP16 (`half=True`) **only on CUDA**, and only if the benchmark shows no change in detections. Always log the final device and the reason.

### 3.4 Ultralytics adapter (primary)
```python
from ultralytics import YOLO
class YoloAdapter:
    def load(self, path, device):
        self.m = YOLO(path)                         # load by local path
        self.names = self.m.names                   # {0:'person', 56:'chair', ...}
        assert self.names[0] == "person", f"Unexpected class map: {self.names[0]}"
        self.device = device
    def warmup(self, n=3, size=640):
        import numpy as np
        for _ in range(n): self.m.predict(np.zeros((size,size,3),np.uint8), device=self.device, verbose=False)
    def infer(self, bgr):                           # BGR numpy straight from OpenCV, no conversion
        r = self.m.predict(bgr, imgsz=640, conf=0.15, iou=0.5, classes=[0],
                           device=self.device, half=self.use_half, verbose=False)[0]
        b = r.boxes                                  # xyxy in the *input image* pixels
        return b.xyxy.cpu().numpy(), b.conf.cpu().numpy()
```
Notes: set `conf` low (0.15) so the **decision layer** applies its own thresholds and can report `uncertain`. YOLO26 outputs end-to-end predictions, so don't add custom NMS. The `iou` argument may be unused. Verify which arguments your installed version accepts rather than assuming. Wrap each call in a timer. Ignore the first call's latency.

### 3.5 RT-DETR adapter (Apache-2.0 fallback)
```python
from transformers import RTDetrForObjectDetection, RTDetrImageProcessor
class RtDetrAdapter:
    def load(self, local_dir, device):
        self.proc = RTDetrImageProcessor.from_pretrained(local_dir)
        self.m = RTDetrForObjectDetection.from_pretrained(local_dir).to(device).eval()
        self.person_id = next(i for i,n in self.m.config.id2label.items() if n == "person")  # never hardcode
        self.device = device
    def infer(self, bgr):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)  # this model expects RGB
        x = self.proc(images=rgb, return_tensors="pt").to(self.device)
        with torch.inference_mode(): out = self.m(**x)
        h, w = bgr.shape[:2]
        res = self.proc.post_process_object_detection(out, target_sizes=torch.tensor([[h, w]]), threshold=0.15)[0]
        keep = res["labels"] == self.person_id
        return res["boxes"][keep].cpu().numpy(), res["scores"][keep].cpu().numpy()
```

### 3.6 Optional pose refinement
`YOLO("weights/yolo26n-pose.pt")` → `r.keypoints.xy` / `r.keypoints.conf`. COCO keypoint indices: hips 11/12, knees 13/14, ankles 15/16. Use as a *supporting* signal only: "hips (≥1) with keypoint conf ≥ 0.4 inside the ROI polygon" strengthens `occupied`. A person walking through the ROI also satisfies this, so rely on temporal persistence (the smoothing and confirmation window), not geometry alone. Run it only when benchmark (C) shows a benefit, because it costs time.

### 3.7 Mapping boxes back (the classic crop bug)
For `roi_crop` mode the detector returns boxes in **crop pixels**. Add the crop offset `(x0, y0)` to get frame pixels, then divide by the frame size for normalized overlay coordinates. Unit-test this with a colored rectangle at a known position.

### 3.8 Decision layer inputs (so models stay swappable)
Every adapter returns only `(boxes_xyxy, scores)` for persons in **crop** coordinates. Everything else (overlap with the ROI polygon, thresholds, smoothing, states) lives in `occupancy/` and is model-agnostic. This is what makes the model replaceable.

## 4. Benchmark protocol (build `scripts/benchmark.py`, output `BENCHMARK.md`)
Run candidates **A** (YOLO26n on padded ROI crop), **A2** (YOLO26s on crop), **B** (YOLO26n on full frame + polygon overlap), **C** (+ pose), **E** (RT-DETR r50vd, crop). Optionally **D** (zero-shot classifier).
- 10 warm-up runs, then ≥200 timed runs per candidate, on the same frames. Report p50/p95/p99 `inference_ms`, achievable FPS, device, RAM/VRAM peak, and the **detections-per-frame** sanity check on a clip with a person and a clip without.
- If no real footage exists, state "accuracy unvalidated" and benchmark **speed only**. Don't make up accuracy numbers.
- Selection rule: choose the **smallest** model whose p95 latency ≤ 60% of the frame budget at `target_inference_fps` (5 FPS → budget 200ms → p95 ≤ 120ms) and which detects a seated person in the sample clip. Otherwise move to the next size. Record the reasoning.
- Save the chosen backend and model in `.env` (`MODEL_BACKEND`, `MODEL_PATH`).

## 5. `app.py` structure and startup sequence
```
app.py  (the only entry point)
  parse CLI/env  →  config.py (validated)
  lifespan startup, in this order, each step logged with duration:
    1. verify weights + sha256              (fail fast with a clear message)
    2. load model on device + warmup        → health.model = ready | error
    3. start metrics collector
    4. start CameraManager (source from config; if none, idle, not an error)
    5. start pipeline worker (capture → crop → infer → decide → state machine → events)
    6. start WS broadcaster
  routes: /api/v1/* , /api/v1/ws , /api/v1/stream/{id}.mjpg
  lifespan shutdown, in reverse: stop pipeline → stop camera (release) → close sockets → flush logs
if __name__ == "__main__":
    uvicorn.run("app:app", host=HOST, port=PORT, workers=1, reload=False, log_level="info")
```
CLI: `python app.py [--demo] [--source usb:0|rtsp://…|file.mp4|synthetic] [--model-backend ultralytics|rtdetr] [--model-path …] [--device auto|cpu|cuda:0|mps] [--port 8000]`.
- **Why `reload=False` and `workers=1`:** `--reload` spawns a second process that opens the camera again (device busy, double inference), and multiple workers each get their own copy of the in-memory state.
- Inference runs in a **dedicated thread** (or `run_in_executor`), never in the event loop. The pipeline keeps only the latest frame. Under load it drops frames and reports `dropped_frames` honestly.
- The model failing to load must **not** crash the server. Health reports `model.state="error"` with the cause, the UI shows it, and seats are `model_error` (never vacant).
- Demo mode (`--demo`) → synthetic source + real model if loadable, else `SimulatedAdapter`, with `simulated:true` on every payload.

## 6. Robustness checklist (implement, test, and tick each item in your final report)
**Correctness invariants**
- [ ] Camera down / stale / no valid frame ⇒ `camera_unavailable`, vacancy timer paused, **no** vacancy alert
- [ ] Model error / not loaded ⇒ `model_error`, **no** vacancy alert
- [ ] One wrong frame cannot raise an alert (K-of-N + EMA + confirmation window), tested with an injected flicker
- [ ] Alerts are deduplicated per `episode_id`, re-alert only after the cooldown, and acknowledge/snooze are honored
- [ ] ROI is always denormalized against the **actual** frame size of the frame being processed
- [ ] Crop is clamped and never empty. A degenerate ROI is rejected with `ROI_INVALID`
- [ ] Low-quality crops (too dark, blurry, tiny) return `uncertain`, not `vacant`
- [ ] Black or constant frames are treated as invalid, not as an empty room

**Operational**
- [ ] Startup self-check prints one summary table (python, torch, device, cv2+FFMPEG, model, hash, licence)
- [ ] `scripts/doctor.py` runs every preflight and returns exit code ≠ 0 on failure
- [ ] Graceful shutdown with no leaked threads (`threading.enumerate()` clean after 20 start/stop cycles)
- [ ] Memory is flat over a 10-minute run (log RSS every 30s; fail if growth > 20%)
- [ ] Bounded queues and ring buffers everywhere (events 1000, latency samples 600, WS per-client latest-only)
- [ ] Rate-limit repeated errors in logs (`inference_error` at most once per 10s per cause)
- [ ] Credentials masked in logs and responses
- [ ] Time uses `time.monotonic()` for durations and UTC for display, so a wall-clock change can't trigger an alert
- [ ] Settings validated and applied live with no restart

## 7. Bug playbook (symptom → likely cause → fix)
| Symptom | Likely cause | Fix |
|---|---|---|
| `ImportError: libGL.so.1` | GUI OpenCV on a server | Use `opencv-python-headless` only (§2.4) |
| `cv2` behaves oddly or lacks FFmpeg | Two OpenCV builds installed | Uninstall both, install headless once |
| `no kernel image is available for execution` | CUDA wheel too old for the GPU | Newer `cuXXX` wheel, or CPU |
| `torch.cuda.is_available()` is False with an NVIDIA GPU | CPU wheel installed or old driver | Reinstall torch with the CUDA index, update the driver |
| Model downloads every run or lands in odd folders | Loaded by name, not path | Fetch once, load by `weights/…` path |
| Camera "busy" immediately after start | `--reload` or a second process | `reload=False`, one worker, kill stray python processes |
| Webcam opens but frames are black on Windows | Wrong backend | Try `CAP_DSHOW` then `CAP_MSMF`, discard the first 10 frames |
| RTSP hangs on connect | No timeout, UDP blocked | Open in a worker thread with a deadline, TCP transport, sub-stream |
| UI video lags seconds behind | Buffered frames | Latest-frame-only slot, `CAP_PROP_BUFFERSIZE=1`, lower preview fps |
| ROI shifted vs. what the user drew | Mixed pixel and normalized coordinates, or letterbox maths in the UI | Normalize against the original frame only. Check the contract's §3 and fix whichever side differs |
| Overlay boxes offset | Forgot crop offset (§3.7) | Add `(x0,y0)`, then normalize by frame size |
| Everything reads "vacant" | Wrong class id, RGB/BGR mix-up, or `conf` too high | Print `names`, check channel order, lower `conf` |
| Person present but `uncertain` often | Crop cuts the person, or the threshold sits between the two | Increase `crop_padding`, benchmark mode B, tune `occupied_conf` |
| WS drops after ~30s | No ping/pong | Implement the contract's heartbeat on both sides |
| CORS errors in the browser console | Origin not allowed for HTTP or WS | Add `localhost:3000` and `127.0.0.1:3000` |
| High CPU, low FPS | Thread oversubscription | §2.6 thread settings, smaller model, lower `target_inference_fps` |
| Event-loop stalls, WS pings late | Blocking call in `async def` | Move inference, `cap.read()`, JPEG encode into threads |
| "Task destroyed but pending" on exit | Tasks not cancelled | Cancel and await in lifespan shutdown |

**Debug discipline:** reproduce → read the real traceback → fix the root cause → re-run the failing test. Max 3 attempts per issue, then stop and report the blocker with what you tried.

## 8. Verification commands (all must pass before reporting done)
```bash
python scripts/doctor.py                    # env, versions, cv2 FFMPEG, duplicate-OpenCV check, weights hashes, port free
python scripts/fetch_models.py              # idempotent
python scripts/benchmark.py --frames 200    # writes BENCHMARK.md
pytest -q -m "not slow"                     # < 60 s
pytest -q -m slow                           # real-model test
python app.py --demo                        # then: curl localhost:8000/api/v1/health
python -m camera.selftest --source synthetic
```
Manual scenario to run and describe in the report: (1) synthetic source, ROI saved, state flips occupied → vacant → alert; (2) kill the source mid-run: expect `camera_unavailable`, **no** alert, recovery; (3) acknowledge, then confirm no repeat alarm; (4) switch sources 20 times, then confirm threads and memory are flat.

## 9. Honest limitations to state in README and UI
- COCO person detectors can miss seated people who are heavily occluded by benches, machinery or a monitor, and can fire on mannequins or posters. Test on the customer's footage.
- A person near the seat is not necessarily sitting in it, and an empty seat doesn't mean the workstation is unattended.
- Latency and FPS depend on hardware. Quote only measured numbers from `BENCHMARK.md`.
- Not a certified safety system.

## 10. Agent working protocol (token budget)
- Plan ≤15 lines, then execute. Don't repeat this file back, and quote only the lines you act on.
- Show **only** failures and key numbers from commands (`-q`, `| tail -n 30`).
- Prefer `str_replace` edits to rewriting files. No whole-file dumps in chat.
- Build order: doctor.py → env → fetch_models → adapters + smoke test → benchmark → camera → crop/decision/state machine + tests → API/WS → integration checklist → docs.
- Final report ≤ 40 lines: chosen model and why, measured latency/FPS/device, licence warning, checklist status (§6), anything not verified.
