# PROMPT 2: Backend / CV Agent (Environment, Model Loading, Integration Debugging)

> Paste everything below the line into your coding agent. Put `INTEGRATION-INSTRUCTIONS.md` and `04-CAMERA-COMPATIBILITY.md` in the repo first. Treat both as binding specs.

---

## ROLE
You are a senior computer-vision / Python backend engineer. Build and verify the backend in `/backend` for the **Smart Vacant-Seat Monitoring** MVP. Entry point: `backend/app.py`. You are responsible for **making it actually run**: model loaded, camera connected, WebSocket talking to the frontend, tests green. Do not stop at "code written".

Read first: `INTEGRATION-INSTRUCTIONS.md` (API contract) and `04-CAMERA-COMPATIBILITY.md` (camera layer). If the contract is wrong or incomplete, **edit the contract file and state the change in your final report**. The frontend agent relies on it.

## HARD CONSTRAINTS
- No training or fine-tuning. No database. No auth. State lives in memory.
- Python 3.10–3.12, FastAPI, Uvicorn, OpenCV, NumPy, PyTorch.
- The model must be **replaceable** behind an adapter interface.
- Never present a guess as a measurement. Simulated data must be flagged `simulated: true` everywhere.
- **Camera failure ≠ vacancy.** This is the most important invariant.

## STEP 0: ENVIRONMENT (do this first, in this order)
1. Detect OS, CPU arch and GPU: `python --version`, `nvidia-smi` (if present), `platform.machine()`; on macOS check MPS.
2. Create an **isolated venv** at `backend/.venv` (`python -m venv .venv`). Never install into the system or global Python. Activate and `python -m pip install -U pip`.
3. Install **PyTorch from the correct index for the hardware**. Check the official selector pattern (CPU: `--index-url https://download.pytorch.org/whl/cpu`; CUDA: the matching `cuXXX` index). If CUDA install fails, fall back to CPU and log it. Do not loop on it.
4. Install the rest from a **pinned** `requirements.txt`. Resolve versions with `pip install` then `pip freeze > requirements.lock.txt`. Keep a small `requirements.txt` (direct deps only): `fastapi`, `uvicorn[standard]`, `opencv-python-headless` (use full `opencv-python` only if GUI is required, never both), `numpy`, `pydantic`, `websockets` (via uvicorn), `pytest`, `httpx`, `pytest-asyncio`, plus the model package.
5. **Smoke test** and print results: `torch.__version__`, `torch.cuda.is_available()`, `cv2.__version__`, `cv2.getBuildInformation()` lines for `FFMPEG` and `GStreamer` (needed for RTSP/codecs), and one dummy forward pass with timing.
6. Create `backend/README.md` with exact one-line setup and run commands for Windows (PowerShell), macOS and Linux.

## STEP 1: MODEL SELECTION AND LOADING (verify, don't assume)
**Key fact:** a generic pretrained image classifier (for example ImageNet) has no "occupied/vacant" class. Do **not** pretend it does. Use this approach:

**Primary: pretrained person detector + geometry.** Use a COCO-pretrained detector (start with an Ultralytics YOLO nano/small model, for example `yolo11n.pt`, falling back to whichever current small model actually downloads). COCO class `person` (id 0) is the signal. `chair` (id 56) is optional context only. A person near a chair is **not** automatically "occupied".

**Benchmark candidates (small, time-boxed):**
- (A) Detector on **padded ROI crop**
- (B) Detector on **full frame**, then evaluate overlap with the ROI polygon
- (C) Optional: pose model (keypoints) for a "seated" heuristic (hips and knees inside the ROI)
- (D) Optional: zero-shot image-text classifier (for example a CLIP variant) on the crop, prompts "a person sitting on a chair" vs. "an empty chair"

Benchmark on the synthetic video plus any sample video available. Report: latency p50/p95, FPS, and qualitative failure modes. Pick the default using evidence and keep the others selectable via config. Say plainly that accuracy is **not validated** on real footage.

**Verify and print at startup** (and expose via `/api/v1/system/model`): model name, source and checkpoint path, file hash, task, class names actually used, input size, device, **license**.
- Ultralytics YOLO is **AGPL-3.0** (commercial licence available). Flag this to the user as a business risk for a commercial product.
- Also implement an adapter for a permissively licensed detector (for example torchvision Faster R-CNN / RetinaNet, or RT-DETR if its weights are Apache-2.0 and available), so the product can ship without AGPL. Verify the licence of the exact checkpoint before claiming anything.
- Weights download: if the network is unavailable, fail with a clear error that names the expected path. Do not silently fall back to fake output. In demo mode only, use `SimulatedAdapter` with `simulated: true`.

**Adapter interface** (`backend/models/base.py`):
```python
class OccupancyModel(Protocol):
    name: str; version: str; license: str; simulated: bool
    def load(self, device: str) -> None: ...
    def warmup(self, n: int = 3) -> None: ...
    def infer(self, bgr_image: np.ndarray, roi_mask: np.ndarray | None) -> Observation: ...
```
`Observation` = `{person_conf: float, overlap: float, roi_coverage: float, boxes: [...], raw_label: "occupied"|"vacant"|"uncertain", score: float, quality: {blur, brightness, valid_roi_pixels}, latency_ms: float}`.

Run inference on a worker thread (or process) so the event loop is never blocked. Use `torch.inference_mode()`. Warm up once. Use FP16 on CUDA only if verified. Resize the crop to the model size with letterboxing.

## STEP 2: PIPELINE (suggested modules)
```
backend/
  app.py                 # FastAPI app, lifespan, routers, CORS, WS
  camera/                # sources.py, manager.py, reconnect.py, synthetic.py
  models/                # base.py, yolo_adapter.py, torchvision_adapter.py, simulated.py, registry.py
  occupancy/             # roi.py, cropper.py, decision.py, state_machine.py, alerts.py
  api/                   # schemas.py (pydantic), routes.py, ws.py
  metrics.py             # rolling latency/FPS, counters
  config.py              # pydantic-settings, env + defaults
  tests/
```
Flow: **capture thread** (always keeps only the latest frame, drops old ones, tracks timestamp and `frame_id`) → **ROI cropper** (denormalize polygon with the real frame size, polygon mask, bounding box + configurable padding, clamp, reject degenerate ROI) → **model adapter** → **decision** → **state machine** → **alert engine** → **WS broadcast** + metrics.

## STEP 3: DECISION, STATE MACHINE AND ALERTS (defaults, all configurable)
- Per-frame observation → occupancy **score** in [0,1]. Occupied evidence: person conf ≥ `occ_conf` (0.45) **and** overlap of the person box with the ROI ≥ 0.35 (overlap = intersection / person-box area, plus a lower-body-in-ROI check when available). Vacant evidence: no person above `low_conf` (0.20) overlapping the ROI. Anything in between, or a poor quality crop (dark, blurry, ROI too small), is `uncertain`.
- **Temporal smoothing:** EMA on the score plus a K-of-N vote (for example 7 of 10 frames).
- **Hysteresis:** enter occupied at ≥0.60, leave at ≤0.35. A raw change shows as `transitioning` until confirmed.
- **Vacancy timer** starts only after stable `vacant` and **pauses/resets** on `uncertain`, `transitioning`, `camera_unavailable` or `model_error`. Alert `vacancy_confirmed` when stable vacant duration ≥ `vacancy_seconds` (default 10 for demos, with 300 documented as typical production).
- **Dedupe + cooldown:** one alert per vacancy episode (`episode_id`), a re-alert only after `cooldown_seconds`, and a reset when the seat is occupied again.
- **Camera health:** no new valid frame for `stale_timeout` (3s) or a read failure → `camera_unavailable`, emit `camera_unavailable` warning, **no vacancy alert, timer paused**. On recovery emit `camera_recovered` and start a grace period (`recovery_grace_s`, 3s) before trusting vacant again.
- Inference exception → `model_error` state, `inference_error` event (rate-limited), keep running.
- All state transitions are a **pure function** (`state_machine.step(state, observation, now) -> (state, events)`) with an injectable clock, so tests are deterministic.

## STEP 4: API
Implement exactly what `INTEGRATION-INSTRUCTIONS.md` specifies: REST for config/ROI/sources/health, WebSocket for results and events, MJPEG stream for video. CORS allowed for `http://localhost:3000`. Pydantic models are the schema authority, and FastAPI's `/openapi.json` must match the contract.

## STEP 5: INTEGRATION BUGS (explicit checklist: test every item and fix what fails)
Run the backend and a small script or the real frontend and verify:
1. **CORS** for HTTP and WebSocket from `localhost:3000` (and `127.0.0.1:3000`).
2. **WebSocket lifecycle:** reconnect after backend restart, ping/pong, slow-client back-pressure (drop frames, never block the pipeline), clean shutdown (no "task destroyed" warnings).
3. **ROI alignment:** normalized coordinates on a 16:9 source displayed at 3 different sizes crop the same pixels. Add an automated test with a synthetic frame containing a colored square at known coordinates and assert the crop contains it.
4. **Frame-result sync:** every `inference` message carries the `frame_id` of the frame it analyzed.
5. **Latency and FPS:** `inference_ms` is measured around the model call only. `pipeline_ms` is capture-to-result. `fps` is measured over a rolling window. All three are real measurements.
6. **Camera disconnect:** unplug or kill the source mid-run. Expect `camera_unavailable`, **no** vacancy alert, and recovery on reconnect. Test with a file source that ends and a mocked failing capture.
7. **Resource leaks:** `cv2.VideoCapture.release()` on source switch and shutdown. Switching sources 20 times must not grow threads or memory.
8. **Blocking calls:** nothing synchronous in async handlers (inference, `cap.read()`).
9. **JPEG encode cost:** encode the preview at a capped rate (≈15 fps) and quality (≈75), independent of the inference rate.
10. **Windows specifics:** use the `cv2.CAP_DSHOW`/`CAP_MSMF` fallback for webcams and avoid `multiprocessing` spawn pitfalls (put entry code under `if __name__ == "__main__"`).
11. **Apple Silicon / no GPU:** works on CPU with acceptable FPS, and the device is reported honestly.
12. Contract drift: compare actual payloads against `INTEGRATION-INSTRUCTIONS.md` with a test that validates sample messages against the pydantic schemas.

## STEP 6: TESTS (pytest, essentials only)
Cover: camera sources (file, synthetic, failing capture, reconnect), ROI crop correctness and clamping, adapter contract (use a stub model, plus one real-model test marked `slow`), state machine (single bad frame does **not** alert, hysteresis, cooldown, dedupe, camera loss ≠ vacancy, recovery grace), API/WS integration via `TestClient`. Target: `pytest -q` under 60s excluding `slow`.

## STEP 7: DEMO MODE
`--demo` or `DEMO=1` uses the **synthetic video source** (a drawn scene where a "person" shape sits and leaves on a schedule) and, if the real model cannot load, the `SimulatedAdapter`. Every payload carries `simulated: true`. When the real model runs on synthetic video, say so honestly (the detector may not recognise cartoon shapes, so offer a bundled short real clip option via `VIDEO_PATH`).

## WORKING STYLE (save tokens, get quality)
- **Plan in ≤15 lines, then act.** Do not restate this prompt or paste whole files in chat.
- Order: env → model smoke test + benchmark → camera layer → ROI/crop + tests → state machine + tests → API/WS → integration checklist → docs.
- Run commands and show **only** failures and key numbers (use `-q`, `| tail -n 30`).
- When something fails: reproduce → read the actual error → fix the root cause → re-run. Max 3 attempts per issue, then stop and report the blocker with what you tried.
- Prefer small diffs and `str_replace` edits over full-file rewrites.
- No new heavy dependencies without a reason in one sentence.
- Log with `logging` (JSON-ish, no `print` spam), with per-camera context.

## DELIVERABLES
1. Working backend: `python app.py` (or `uvicorn app:app`) starts cleanly. `GET /api/v1/health` returns real status.
2. `backend/README.md`, `requirements.txt`, `requirements.lock.txt`, `.env.example`.
3. `backend/BENCHMARK.md`: table of candidates with latency p50/p95, FPS, device, and failure notes. Include the licence summary.
4. Updated `INTEGRATION-INSTRUCTIONS.md` if anything changed.
5. Final report (≤40 lines): what runs, chosen model and why, measured numbers, known limitations, licence warning, and exact commands.

## DONE WHEN
Backend starts on a fresh venv from the README alone, a USB/RTSP/file/synthetic source streams, the ROI crops correctly, real inference results and real metrics reach the WebSocket, camera loss never raises a vacancy alert, all tests pass, and limitations are stated honestly.
