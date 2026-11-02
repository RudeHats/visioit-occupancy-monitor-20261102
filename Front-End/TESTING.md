# Streaming and connection verification

Install frontend dependencies with `pnpm install`, then install the browser once:

```powershell
pnpm exec playwright install chromium
```

Run backend regressions from the repository root with
`.\.venv\Scripts\python.exe -m pytest -q`. Run frontend unit and backend-contract
tests with `pnpm test`, and type checks with `pnpm typecheck`.

The browser tests exercise the real root layout and the real backend through the
Next.js `/backend` proxy. They require a running frontend and backend, the real
YOLO model, and a reachable camera feed. They verify decoded images and received
WebSocket inference/metrics, reload persistence, rejected source restoration,
and recovery after injected health-request failures.

Start the backend from the repository root:

```powershell
.\.venv\Scripts\python.exe app.py --source rtsp://192.168.137.134:8554/
```

Start `pnpm dev` in this directory. In another frontend terminal:

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:3000'
$env:E2E_RTSP_URL='rtsp://192.168.137.134:8554/'
pnpm test:e2e
```

`BACKEND_URL` sets the server-side proxy target (default `http://127.0.0.1:8000`).
For isolated verification, set `NEXT_DIST_DIR=.next-verification`, use frontend
port 3011, and point `BACKEND_URL` to a backend on port 8011. Failure traces are
retained under `test-results/`. No camera screenshots are committed.

`--demo` intentionally uses a simulated detector even with a real source; omit
it to verify real inference. CPU-only PyTorch reports `cpu` honestly.
