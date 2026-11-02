# 04: Camera & Video Source Compatibility Spec (Backend)

Goal: the system accepts **any camera or video the host can decode** (USB, IP/RTSP, HTTP MJPEG, files, synthetic) through one uniform interface, with clear errors, automatic recovery, and **no false vacancy when a source fails**. Compatibility is not guaranteed for every device, because it depends on drivers, protocols, codecs, permissions and the OpenCV/FFmpeg build. The system must say so clearly when something fails.

## 1. Unified interface (`backend/camera/`)
```python
class FrameSource(Protocol):
    type: str
    def open(self) -> OpenResult: ...          # returns ok/err code + frame_size
    def read(self, timeout_s: float) -> Frame | None   # Frame(image BGR uint8, ts_monotonic, frame_id, wall_ts)
    def close(self) -> None: ...
    def describe(self) -> dict                 # safe (no credentials)
```
Implementations: `UsbSource`, `RtspSource`, `HttpMjpegSource`, `FileSource`, `SyntheticSource`. Add new device types by adding a class and registering it. Do not change the pipeline.

`CameraManager` owns one source at a time (design so multi-camera is possible later):
- **Capture thread**: loops `read()`, keeps **only the latest frame** (size-1 slot, so old frames are dropped to prevent lag), stamps `frame_id`, `ts_monotonic`, counts dropped frames.
- **Health**: `connecting | connected | reconnecting | disconnected`, `last_frame_age_ms`, `consecutive_failures`, last error code and hint.
- **Auto-reconnect**: exponential backoff 0.5s → 1 → 2 → 5 → 10s (max), with jitter, forever, until the user stops it. Each attempt fully `release()`s and re-creates the capture object.
- **Stale watchdog**: if no valid frame within `stale_timeout_s` (default 3s) → state `reconnecting` and **publish `camera_unavailable`**, even if `read()` is blocking (use a watchdog thread and a read timeout where the backend supports it).
- **Frame validation**: reject `None`, empty, wrong dtype, or all-black/all-constant frames (a common failure signature) as invalid. Count them.
- Source switching: stop, join thread (timeout 3s), release, then start. It must be safe to repeat 20+ times with no leaked threads or file handles.

## 2. Source types

### USB / built-in webcams
- Open by index: `cv2.VideoCapture(index, backend)`. Backend order by OS: **Windows** `CAP_DSHOW` → `CAP_MSMF` → default; **Linux** `CAP_V4L2` → default; **macOS** `CAP_AVFOUNDATION` → default.
- Probe devices `0..9` on request only (`GET /sources/usb`), with a short timeout and the camera released immediately. Do not probe continuously (it is slow and can disturb devices). Return index, resolution and which backend worked.
- Request settings but **read back what the driver actually applied**: `CAP_PROP_FRAME_WIDTH/HEIGHT`, `FPS`. Prefer `MJPG` FOURCC for higher resolution over USB 2 (`cap.set(CAP_PROP_FOURCC, MJPG)`), fall back if rejected. Set `CAP_PROP_BUFFERSIZE=1` where supported.
- Warm-up: discard the first 5 to 10 frames (auto-exposure). Warm-up frames must not be fed to inference.
- Errors to map: device busy (another app is using it), permission denied (macOS/Windows camera privacy settings, Linux `video` group), not found.

### IP cameras: RTSP (and RTSPS)
- URL forms: `rtsp://user:pass@host:554/path`. Vendors differ in path (for example `/Streaming/Channels/101`, `/h264`, `/cam/realmonitor?channel=1&subtype=1`, `/stream1`, `/live`). Accept any user-supplied URL, and **URL-encode** special characters in credentials. Offer **sub-stream** advice in the UI hint (lower resolution is much easier to decode and enough for a seat ROI).
- Use `cv2.VideoCapture(url, cv2.CAP_FFMPEG)`. Before opening set `OPENCV_FFMPEG_CAPTURE_OPTIONS="rtsp_transport;tcp|stimeout;5000000|fflags;nobuffer|flags;low_delay"` (TCP is more reliable than UDP through firewalls/Wi-Fi). Offer a `transport: tcp|udp` setting and try TCP first, then UDP.
- **Connection timeout** (≈5 to 8s) so an unreachable camera does not hang the app. Run `open()` in a worker thread with a deadline.
- Codecs: H.264 is broadly supported. H.265/HEVC depends on the FFmpeg build and OS decoder and may fail or be slow. If unsupported, return `SOURCE_CODEC_UNSUPPORTED` with the hint "Switch the camera stream to H.264 or use the sub-stream."
- Latency control: read in a dedicated thread, always drop to the newest frame (do not let OpenCV's internal buffer accumulate).
- Optional upgrade path: if OpenCV cannot decode a stream, document using an `ffmpeg` subprocess (pipe raw frames), or GStreamer if the OpenCV build supports it. Check `cv2.getBuildInformation()` for `FFMPEG: YES` and `GStreamer: YES/NO` and report this in `/system`.
- **Never log or return passwords.** Mask as `rtsp://user:***@host/...`.
- ONVIF discovery is **out of scope for the MVP**. Document it as a future option.

### HTTP MJPEG / HTTP snapshot URLs
- `http://host/video.mjpg` via `cv2.VideoCapture` (FFMPEG backend). For snapshot-only URLs (`/snapshot.jpg`), poll with `httpx` at `target_fps`, decode with `cv2.imdecode`, and support Basic/Digest auth. Many phone IP-camera apps use this.

### Video files
- Any container/codec FFmpeg can decode (mp4, avi, mkv, mov, webm). `loop: true` by default for demos. Honor the file's FPS (sleep to real time, or use "as fast as possible" only when `realtime=false`). Report `file_ended` clearly, and with `loop: false` emit a distinct "Source ended" message, which must **not** be treated as vacancy.
- Validate the path (exists, readable, is a file) and reject path traversal in the upload endpoint.

### Synthetic source (demo and tests)
- Generates frames with OpenCV drawing: a floor/workstation scene, a chair, and a simple figure that "sits" and "leaves" on a configurable schedule, with optional noise and brightness changes. It exposes the ground-truth schedule for tests (so state-machine tests can assert exact transitions).
- All frames and results derived from it are `simulated: true`. A detector may not recognize cartoon figures, so ground truth comes from the schedule and **real inference output must not be fabricated** to match it. Offer `VIDEO_PATH` for a real clip as the honest model demo.

## 3. Resolution and performance policy
- Keep the **original frame** for cropping (ROI accuracy) and use a downscaled copy only for the MJPEG preview.
- If the frame is larger than 1920×1080, still crop from full-res, but cap decode cost via the camera's sub-stream when possible.
- `target_inference_fps` default 5 (seat occupancy changes slowly). Skip frames to hit it, always processing the **latest** frame.
- Handle changing resolution mid-stream (some IP cameras renegotiate): detect size change, update `frame_size`, and keep ROI valid thanks to normalized coordinates. Emit `config_changed`.

## 4. Failure taxonomy → codes → user hint
| Situation | Code | Hint shown in UI |
|---|---|---|
| Index doesn't exist | `SOURCE_NOT_FOUND` | Check the cable and try another index |
| Device busy | `SOURCE_CONNECT_FAILED` | Close other apps using the camera |
| OS permission | `SOURCE_PERMISSION_DENIED` | Allow camera access in OS privacy settings |
| Bad URL / unreachable host | `SOURCE_CONNECT_FAILED` | Check IP, port, network, VPN |
| Wrong credentials | `SOURCE_AUTH_FAILED` | Check username/password (special characters need URL-encoding) |
| Timeout | `SOURCE_TIMEOUT` | Camera too slow or blocked. Try TCP, or a sub-stream |
| H.265 or unknown codec | `SOURCE_CODEC_UNSUPPORTED` | Use H.264 or the sub-stream |
| Frames stop mid-run | event `camera_unavailable` | Auto-reconnecting… |
| File ended (no loop) | `source_ended` info | Choose another source |
All of these map to state `camera_unavailable`. **None may produce a vacancy alert.**

## 5. Compatibility self-test (build it)
`python -m camera.selftest --source usb:0 | rtsp://... | file.mp4 | synthetic` prints: opened (y/n), negotiated resolution, measured FPS over 5s, decode errors, first-frame latency, black-frame check, backend used, and OpenCV FFmpeg/GStreamer availability. Expose the same result via `POST /api/v1/sources/test`, which tests without switching the active source. The UI uses it for a **"Test connection"** button.

## 6. Tests (no real hardware needed)
- Mock `cv2.VideoCapture` to simulate: open failure, `read()` returning `False` repeatedly, slow reads, black frames, resolution change.
- Assert: state → `reconnecting`, event `camera_unavailable` emitted, **no vacancy alert**, recovery path, and no thread leak after 20 switches.
- File source: loop on/off behavior. Synthetic: schedule ground truth.
- Credential masking test: no `pass` substring in logs or responses.

## 7. Configuration (`.env`)
```
SOURCE_TYPE=synthetic            # usb|rtsp|http_mjpeg|file|synthetic
USB_INDEX=0
RTSP_URL=
RTSP_TRANSPORT=tcp
VIDEO_PATH=
TARGET_FPS=15
STALE_TIMEOUT_S=3
RECONNECT_MAX_BACKOFF_S=10
```
Credentials come from env or the select request body and are held in memory only. Nothing is persisted.

## 8. Known limits (state them honestly in the UI and README)
Some cameras (proprietary SDKs, thermal, GigE Vision/industrial machine-vision cameras, NDI/SRT, H.265-only streams without decoder) are **not supported by plain OpenCV** and need an adapter or a gateway that re-streams them as RTSP/MJPEG. Support depends on drivers, protocols, codecs, permissions and the installed OpenCV/FFmpeg build.
