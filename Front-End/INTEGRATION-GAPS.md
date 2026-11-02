# Integration gaps

## Status: integration wired, live demo running

- The frontend now speaks the backend contract in `Instructions/INTEGRATION-INSTRUCTIONS.md` (contract `1.0`).
- Added `lib/monitoring/api.ts` (REST client + backend → UI mappers), `lib/monitoring/ws.ts` (validated WebSocket client with heartbeat + reconnect), and backend state ingestion in `lib/monitoring/store.ts`.
- `/live` renders the backend MJPEG stream (`GET /api/v1/stream/{camera_id}.mjpg`), backend seat regions, backend metrics/confidence, and the backend alert flow (`POST /api/v1/demo/trigger`, alerts ack/snooze).
- `/overview`, `/events`, `/settings`, `/system` render backend data when the backend is connected; mock mode remains available behind `NEXT_PUBLIC_USE_MOCK=true`.
- Backend startup bugs found and fixed during integration: Pydantic request models were declared inside `create_app` (unresolvable with `from __future__ import annotations`) and the `WebSocket` annotation needed module-scope resolvability. Both fixed in `app.py`.

## Remaining gaps (not blocking the live demo)

1. **Persistence** — backend state and event history are in-memory only; restarts clear sessions (documented in the contract).
2. **Authentication** — none; dev-only deployment.
3. **Multi-camera** — single active source supported; multi-camera product model still open.
4. **Real occupancy model** — demo runs on the simulated colour-blob adapter (`--demo`); real YOLO backend pending weight download/licence checks.
5. **ROI save semantics** — frontend `PUT /api/v1/seats/{id}` writes the polygon; crop-preview is read-only verification.
6. **Settings mapping** — frontend preview settings map onto backend settings keys on save (vacancy/cooldown/confidence); per-seat overrides not yet surfaced.
7. **Event types** — backend emits `seat_occupied` / `seat_vacant` / `camera_recovered` in addition to `vacancy_confirmed`; the UI event list and alert banner handle the vacancy-critical path.

## Current preview behavior

- The simulator is opt-in only: set `NEXT_PUBLIC_USE_MOCK=true` in a development/preview environment. It is disabled when the variable is unset or any other value.
- All fixture data, trend points, and the generated camera still are local illustrative content. Affected panels display a visible `SIMULATED` badge; none of these values represent a connected camera, deployed model, validated accuracy, or measured uptime.
- Settings and event acknowledgements are held in Zustand memory for the current page session only; refresh resets them.
- ROI editing stores normalized coordinates in the local preview. `Test crop` is explicitly a local visual approximation, not a backend crop response.
- With mock mode off, pages render disconnected/empty states rather than silently falling back to sample values.

Provide the backend contract before enabling production API or stream integration. The preview-state Zod schema is intentionally limited to the state enum and local form validation; it is not claimed to validate backend payloads.
