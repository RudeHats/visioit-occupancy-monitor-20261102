# INTEGRATION-INSTRUCTIONS.md
**Smart Vacant-Seat Monitoring: Frontend ⇄ Backend Contract** · Contract version `1.0`

This is the single source of truth for how the Next.js frontend and the FastAPI backend talk to each other. If either side needs a change, **edit this file first**, then the code. Pydantic schemas (backend) and Zod schemas (frontend) must mirror it.

---

## 1. Runtime topology
| Component | Default address |
|---|---|
| Frontend (Next.js) | `http://localhost:3000` |
| Backend (FastAPI)  | `http://localhost:8000` (`ws://localhost:8000`) |

- CORS: backend allows origins `http://localhost:3000` and `http://127.0.0.1:3000` (HTTP and WebSocket).
- All REST routes are prefixed `/api/v1`. All timestamps are **ISO-8601 UTC strings** plus a monotonic `t_ms` where noted. All durations are **seconds** (float) unless suffixed `_ms`.
- State is in memory only and resets on backend restart. Every payload that includes simulated data carries `"simulated": true`.

## 2. End-to-end data flow
```
Camera/Video ─► capture thread (latest frame only, frame_id++, timestamp)
                    │
                    ├─► JPEG encoder (≤15 fps) ──► GET /stream/{camera_id}.mjpg ──► <img> in UI
                    │
                    └─► ROI crop (denormalize polygon → mask → padded bbox)
                           └─► Model adapter (person detection + overlap geometry)
                                  └─► Observation (conf, overlap, quality, latency_ms)
                                         └─► Decision + smoothing + hysteresis (state machine)
                                                └─► Events (vacancy_confirmed, camera_unavailable, ...)
                                                       └─► WebSocket /ws ──► UI (badges, charts, alert banner, sound)
```
Video and results travel on separate channels. The UI joins them by `frame_id`. The overlay draws the latest `inference` result on top of the live image.

## 3. Coordinate system (critical)
- ROI points are **normalized `[x, y]`, each in `[0,1]`, relative to the original (un-resized) camera frame**: `(0,0)` top-left, `(1,1)` bottom-right.
- A rectangle is sent as 4 points in clockwise order. A polygon has 3 to 12 points, must be simple (no self-intersection) and have an area ≥ 0.5% of the frame.
- Backend conversion: `px = round(x * frame_width)`, `py = round(y * frame_height)`, then clamp to the frame. Crop = padded bounding box of the polygon (`crop_padding`, default `0.10` of the box size) with pixels outside the polygon **kept** in the crop (context helps detection) but outside-polygon pixels are masked out of the **overlap calculation**.
- The frontend computes the displayed video rectangle (letterbox aware) and converts pointer positions to normalized coordinates against it. The ROI must stay aligned at any window size.

## 4. Enumerations
**`SeatState`:** `occupied | vacant | uncertain | transitioning | camera_unavailable | model_error`
**`Severity`:** `info | warning | critical`
**`SourceType`:** `usb | rtsp | http_mjpeg | file | synthetic`
**`EventType`:**
| type | severity | when |
|---|---|---|
| `seat_occupied` | info | stable transition to occupied |
| `seat_vacant` | info | stable transition to vacant (timer starts) |
| `vacancy_confirmed` | **critical** | stable vacant ≥ `vacancy_seconds` → **UI alert + sound** |
| `seat_uncertain` | warning | uncertain longer than `uncertain_warn_seconds` (default 30) |
| `camera_unavailable` | warning | no valid frame for `stale_timeout_s`, or read failure |
| `camera_recovered` | info | frames resumed |
| `inference_error` | warning | model raised, rate-limited |
| `config_changed` | info | ROI/settings/source changed |
| `model_loaded` | info | model ready (includes name) |

**Invariant:** `camera_unavailable` and `model_error` **never** produce `vacancy_confirmed`, and they pause the vacancy timer.

## 5. REST API
### 5.1 Health / system
`GET /api/v1/health`
```json
{ "status": "ok|degraded|down", "backend_version": "0.1.0", "contract_version": "1.0",
  "uptime_s": 123.4, "simulated": false,
  "camera": { "state": "connected|connecting|reconnecting|disconnected", "last_frame_age_ms": 40, "message": null },
  "model":  { "state": "ready|loading|error", "name": "yolo11n", "message": null } }
```
`GET /api/v1/system/model`
```json
{ "name":"yolo11n","version":"...","task":"detect","device":"cpu|cuda:0|mps","input_size":640,
  "classes_used":["person"],"checkpoint":"weights/yolo11n.pt","sha256":"...",
  "license":"AGPL-3.0 (verify for commercial use)","simulated":false,
  "mode":"roi_crop|full_frame_overlap" }
```
`GET /api/v1/system/metrics` returns the current snapshot (same shape as the WS `metrics` message, see 6.4).

### 5.2 Sources (camera / video)
`GET  /api/v1/sources/usb` → list of probed devices: `[{ "index":0, "label":"Camera 0", "resolution":[1280,720], "backend":"DSHOW" }]`
`GET  /api/v1/sources/active` → current source.
`POST /api/v1/sources/select`
```json
{ "type":"usb|rtsp|http_mjpeg|file|synthetic",
  "usb_index": 0,
  "url": "rtsp://user:pass@192.168.1.10:554/stream1",
  "path": "C:/videos/line1.mp4",
  "loop": true, "target_fps": 15, "resolution": [1280,720] }
```
Response `200`: `{ "camera_id":"cam0", "state":"connecting", "frame_size":[1280,720] | null }`
Errors use the shape in §8, for example `SOURCE_CONNECT_FAILED`, `SOURCE_AUTH_FAILED`, `SOURCE_NOT_FOUND`, `SOURCE_CODEC_UNSUPPORTED`.
**Credentials in RTSP URLs are never echoed back or logged**, and responses return the URL with the password replaced by `***`.
`POST /api/v1/sources/upload` (multipart video file) → `{ "path": "<server path>" }` (optional, local use only).
`POST /api/v1/sources/stop`.

### 5.3 Seats / ROI
`GET  /api/v1/seats` → `[Seat]`
`POST /api/v1/seats` → create. `PUT /api/v1/seats/{seat_id}` → update. `DELETE /api/v1/seats/{seat_id}`.
```json
// Seat
{ "seat_id":"seat-1", "name":"Station 4 / Seat A", "camera_id":"cam0",
  "polygon":[[0.31,0.42],[0.52,0.42],[0.52,0.81],[0.31,0.81]],
  "enabled": true, "settings": { /* optional per-seat overrides of §5.4 */ },
  "reference_frame_size":[1280,720] }
```
`POST /api/v1/seats/{seat_id}/crop-preview` → `{ "image_jpeg_base64":"...", "crop_box_px":[x,y,w,h], "frame_size":[1280,720] }` (the exact pixels sent to the model, so the UI can show "what the model sees").
Validation errors → `422` with code `ROI_INVALID` and a human-readable `message`.

### 5.4 Settings
`GET /api/v1/settings` · `PUT /api/v1/settings`
```json
{ "vacancy_seconds": 10, "cooldown_seconds": 120,
  "occupied_conf": 0.45, "low_conf": 0.20,
  "enter_occupied": 0.60, "exit_occupied": 0.35,
  "smoothing_window": 10, "smoothing_required": 7,
  "uncertain_warn_seconds": 30, "stale_timeout_s": 3, "recovery_grace_s": 3,
  "crop_padding": 0.10, "inference_mode": "roi_crop|full_frame_overlap",
  "target_inference_fps": 5, "min_alert_severity_for_sound": "critical" }
```
Changes apply live and emit a `config_changed` event. Out-of-range values return `422 SETTINGS_INVALID`.

### 5.5 Events and alerts
`GET  /api/v1/events?limit=200&seat_id=&type=&since=` → `[Event]` (in-memory ring buffer, 1000 max)
`POST /api/v1/alerts/{alert_id}/ack` → `{ "acknowledged": true }`
`POST /api/v1/alerts/{alert_id}/snooze` body `{ "seconds": 300 }`
`POST /api/v1/demo/trigger` (demo mode only) → forces a simulated vacancy event, flagged `simulated: true`.

## 6. WebSocket: `GET ws://localhost:8000/api/v1/ws`
JSON text messages: `{ "type": "...", "ts": "<ISO>", "t_ms": 1234567, "data": {...} }`.
Client may send `{ "type":"ping" }` every 10s and the server replies `{ "type":"pong" }`. The server also sends a `hello` first. If the client is silent for 30s the server closes the socket. The server keeps **only the latest** `inference` per seat for a slow client (drop, never queue).

### 6.1 `hello` (on connect)
`data`: `{ "contract_version":"1.0","backend_version":"0.1.0","simulated":false,"snapshot": { "seats":[SeatStatus], "settings":{...}, "health":{...} } }`
The UI renders from the snapshot immediately, with no waiting for the next frame.

### 6.2 `inference` (per processed frame, per seat, ≤ `target_inference_fps`)
```json
{ "type":"inference","data":{
  "seat_id":"seat-1","camera_id":"cam0","frame_id":10542,
  "raw_label":"occupied","state":"occupied","confidence":0.87,
  "score_smoothed":0.82,
  "person_conf":0.87,"overlap":0.61,
  "boxes":[{"cls":"person","conf":0.87,"xyxy_norm":[0.30,0.20,0.60,0.88]}],
  "quality":{"blur":142.0,"brightness":96.0,"valid_roi_pixels":58231,"ok":true},
  "vacant_for_s":0.0,
  "latency":{"inference_ms":24.3,"crop_ms":0.6,"pipeline_ms":41.0},
  "simulated":false } }
```
`confidence` = confidence in the **reported `state`**, defined by the backend as `max(score_smoothed, 1-score_smoothed)` for occupied/vacant, and `null` for `camera_unavailable`/`model_error`. `boxes` use **normalized frame coordinates** for overlay drawing.

### 6.3 `state_change`
`data`: `{ "seat_id","from","to","reason":"hysteresis_confirmed|camera_lost|model_error|recovered","since":"<ISO>" }`

### 6.4 `metrics` (≈1 Hz)
```json
{ "type":"metrics","data":{
  "capture_fps":14.8,"processing_fps":5.0,"preview_fps":14.9,
  "inference_ms":{"p50":22.1,"p95":31.0,"p99":40.2,"last":24.3},
  "pipeline_ms":{"p50":38.0,"p95":55.0},
  "dropped_frames":12,"inference_errors":0,
  "confidence_hist":{"bins":[0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0],"counts":[...]},
  "device":"cpu","cpu_percent":41.0,"mem_mb":812,"simulated":false } }
```
Every number is **measured**. Use `null` when unknown. Never send placeholders.

### 6.5 `event`
```json
{ "type":"event","data":{
  "event_id":"evt_000123","alert_id":"alt_000045 | null","type":"vacancy_confirmed",
  "severity":"critical","seat_id":"seat-1","camera_id":"cam0",
  "message":"Seat vacant for 10 s (threshold 10 s)",
  "vacant_duration_s":10.4,"episode_id":"ep_17","sound":true,"simulated":false,
  "created_at":"<ISO>" } }
```
`sound: true` is the backend's decision to request an audible alarm (critical, not snoozed/acked, not in cooldown). The UI additionally requires the user to have enabled sound.

### 6.6 `health`
`data`: same as `GET /health`. Sent on any change in camera/model health and at least every 5s.

## 7. Video stream
`GET /api/v1/stream/{camera_id}.mjpg`: `multipart/x-mixed-replace; boundary=frame`, quality ≈75, ≤15 fps, original aspect ratio (no server-side letterbox). Response headers: `X-Frame-Width`, `X-Frame-Height`. If the camera is down the stream stays open and serves a clearly marked **"No signal"** placeholder JPEG (never the last frozen frame presented as live). The UI also relies on `health.camera.state` to show the "Camera unavailable" overlay.
`GET /api/v1/stream/{camera_id}/snapshot.jpg` returns a single frame for the ROI editor (frozen reference frame, so drawing is not disturbed by motion).

## 8. Error format (all REST errors)
```json
{ "error": { "code":"SOURCE_CONNECT_FAILED", "message":"Could not open rtsp://***@192.168.1.10:554/...",
             "hint":"Check URL, credentials, network, and that FFmpeg support is available in OpenCV.",
             "retryable": true } }
```
Codes: `SOURCE_CONNECT_FAILED`, `SOURCE_AUTH_FAILED`, `SOURCE_NOT_FOUND`, `SOURCE_CODEC_UNSUPPORTED`, `SOURCE_PERMISSION_DENIED`, `SOURCE_TIMEOUT`, `ROI_INVALID`, `SETTINGS_INVALID`, `MODEL_NOT_READY`, `MODEL_LOAD_FAILED`, `INFERENCE_FAILED`, `NOT_FOUND`, `INTERNAL`.

## 9. Decision logic (reference, so both sides agree on semantics)
1. **Crop:** padded bbox of the ROI polygon from the **latest** frame (never a resized preview).
2. **Detect:** pretrained person detector. Overlap = `intersection(person_box ∩ ROI_polygon) / area(person_box)`, plus a lower-body-in-ROI check when keypoints are available.
3. **Per-frame label:** `occupied` if `person_conf ≥ occupied_conf` and `overlap ≥ 0.35`. `vacant` if no person above `low_conf` overlaps the ROI. Otherwise, or if image quality fails, `uncertain`.
4. **Smoothing:** EMA of the occupancy score plus K-of-N voting. **Hysteresis:** enter occupied ≥ `enter_occupied`, leave ≤ `exit_occupied`. While the raw label disagrees with the stable state the reported state is `transitioning`.
5. **Vacancy timer:** runs only in stable `vacant`. It pauses and resets on `uncertain`, `transitioning`, `camera_unavailable`, `model_error`.
6. **Alert (false-alarm protections):** `vacancy_confirmed` once per `episode_id` when `vacant_for_s ≥ vacancy_seconds`. A single wrong frame cannot alert because of smoothing and the confirmation window. Re-alert only after `cooldown_seconds` (and only if still vacant). Occupied again → episode closed. Acknowledged or snoozed alerts do not sound.
7. **Camera health:** frame age > `stale_timeout_s` or read failure → `camera_unavailable` (+ `camera_unavailable` event). After recovery wait `recovery_grace_s` before trusting `vacant`.

## 10. Alert + sound handshake
1. Backend emits `event{type:"vacancy_confirmed", alert_id, sound:true}` once per episode and cooldown.
2. Frontend dedupes by `alert_id`, shows `AlertBanner`, and, if the user has enabled sound (AudioContext unlocked by a click), plays the alarm. If audio is blocked it shows "Sound blocked by browser. Click to enable".
3. User clicks Acknowledge → `POST /alerts/{alert_id}/ack` → alarm stops and later repeats for the same episode are suppressed.
4. Snooze → `POST /alerts/{alert_id}/snooze`.
5. The frontend must never play sound for `info` events or for events with `sound:false`.

## 11. Staleness and honesty rules
- If the WebSocket is disconnected, the UI marks all seat data **stale**. It never presents old data as current.
- `simulated: true` anywhere → the UI shows a **SIMULATED** badge on that panel.
- Latency, FPS and confidence shown in the UI come only from §6 payloads.
- Accuracy is **not** claimed. `/system` displays a validation disclaimer.

## 12. Versioning and compatibility
Additive changes (new optional fields) keep `1.x`. Breaking changes bump the major version. The frontend ignores unknown fields and rejects a different major version in `hello` with a visible "Version mismatch" error.

## 13. Test fixtures both teams share
Put sample payloads in `/contract-fixtures/*.json` (one per message type and one per error code). Backend tests validate its output against them, and frontend tests parse them with Zod.

## 14. Local run
```
# Terminal 1
cd backend && .venv/Scripts/activate  # (macOS/Linux: source .venv/bin/activate)
python app.py            # http://localhost:8000  (docs at /docs)
# Terminal 2
cd frontend && npm install && npm run dev   # http://localhost:3000
```
Demo (no camera or model hardware): `python app.py --demo` → every payload has `simulated:true`.
