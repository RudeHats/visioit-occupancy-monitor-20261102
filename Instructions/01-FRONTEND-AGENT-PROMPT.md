# PROMPT 1: Frontend Agent (Premium Industrial Dashboard)

> Paste everything below the line into your coding agent. Put `INTEGRATION-INSTRUCTIONS.md` in the repo root first. It is the single source of truth for the API.

---

## ROLE
You are a senior frontend engineer and product designer. Build the **Smart Vacant-Seat Monitoring** dashboard in `/frontend`. It will be shown to potential industrial customers, so it must look premium, calm and trustworthy. The backend is built separately. **Read `INTEGRATION-INSTRUCTIONS.md` fully before writing code and follow it exactly.** If something is ambiguous or missing, record it in `frontend/INTEGRATION-GAPS.md` and do not guess silently.

## STACK (fixed)
- Next.js (App Router) + React + TypeScript (`strict: true`)
- Tailwind CSS + shadcn/ui on Radix UI primitives
- Lucide React icons (one stroke width, 1.75, across the app)
- Recharts for charts
- `next/font`: **Inter** (UI) and **JetBrains Mono** (numbers, timestamps, IDs)
- State: Zustand (or React context plus reducers). No Redux.
- Validation of backend payloads: **Zod** schemas that mirror the integration contract.
- Install the latest stable versions. Run `npm view <pkg> version` once per package. Do not guess versions.

## DESIGN LANGUAGE ("graphite industrial")
Dark-first, restrained and precise. Nothing neon or gamer-like.

**Tokens (define as CSS variables in `globals.css`, map in the Tailwind config):**
| Token | Value | Use |
|---|---|---|
| `--bg` | `#0B0D10` | app background |
| `--surface-1` | `#12151A` | cards |
| `--surface-2` | `#181C22` | raised or hover |
| `--border` | `#262B33` | hairlines (1px) |
| `--text` | `#E6E8EB` | primary text |
| `--text-muted` | `#8A929D` | secondary text |
| `--accent` | `#5B8DEF` | neutral accent (selection, focus rings, ROI edit) |
| `--ok` | `#3FB68B` | occupied / healthy |
| `--warn` | `#E0A93B` | uncertain / transitioning / degraded |
| `--danger` | `#E5484D` | vacancy alert / error |
| `--neutral-state` | `#6B7380` | vacant (pre-alert) / unavailable |

Rules:
- Use color **sparingly**. Status color appears only on small elements (a dot, a badge, a 2px left edge), never as a full card fill.
- Never rely on color alone. Every status has an **icon + label** (WCAG AA contrast).
- Radius 10px for cards and 6px for controls. Soft 1px borders, with almost no shadows. Use subtle 4% white inner top-highlights for depth.
- Spacing is on an 8px grid. Cards have generous padding (20 to 24px). Use tabular numbers (`font-variant-numeric: tabular-nums`) for all metrics.
- Motion: 120 to 180ms ease-out only. Add a gentle pulse on the live dot and a restrained alert glow on the card edge. Respect `prefers-reduced-motion`.
- Include a **light theme** via tokens only if it takes under 30 lines. Dark is the default and the priority.
- Responsive: usable from 360px phone to 4K wall display. Sidebar collapses to a bottom or hamburger nav under `md`.

## PAGES AND ROUTES
1. `/` **Overview**: KPI row (Occupied, Vacant, Uncertain, Unavailable counts, each with an icon and a tiny sparkline), seat status grid (one card per seat: name, state badge, confidence, time in state, mini thumbnail), recent events list, system health strip (camera, model, WebSocket).
2. `/live` **Live Monitoring**: large video panel with ROI overlay, right-hand inspector (state, confidence, latency, FPS, vacancy timer countdown), alert banner area, event timeline below.
3. `/live` **Seat Region Editor** (a mode inside Live, toggled with "Edit regions"): rectangle and polygon tools, drag handles, snap-to-pixel off, Undo, Delete, Save, Cancel, "Test crop" (shows the backend's returned crop preview).
4. `/events` **Events**: filterable table (type, severity, seat, time) with a vacancy-duration column and "Acknowledge". This is session memory only, so show the notice "History resets when the backend restarts".
5. `/settings` **Settings**: video source selector (USB index list, RTSP URL, file upload or path, Demo/Synthetic), vacancy duration, confidence thresholds, alert cooldown, sound toggle and volume plus a "Test sound" button, model selection (when the backend exposes it).
6. `/system` **Model & System**: model name, version, task, device (CPU/CUDA/MPS), classes used, license note, latency p50/p95/p99 chart, FPS chart, confidence histogram, dropped-frame counter, camera health log, backend version.

Persistent shell: left sidebar (Lucide icons), top bar with a **connection pill** (Connected / Reconnecting / Offline), a **DEMO / SIMULATED badge** whenever the backend reports `simulated: true`, and a global mute toggle.

## KEY COMPONENTS (build once, reuse)
`StatusBadge`, `KpiCard`, `SeatCard`, `VideoPanel`, `RoiOverlay`, `RoiEditor`, `MetricTile`, `LatencyChart`, `FpsChart`, `ConfidenceChart`, `OccupancyTimeline` (horizontal band chart: state over time), `EventList`, `AlertBanner`, `HealthPill`, `SourceSelector`, `ThresholdForm`, `EmptyState`, `ErrorState`, `Skeleton`s.

## STATE → UI MAPPING (mandatory, must match the backend enum exactly)
| state | icon | color | meaning shown to user |
|---|---|---|---|
| `occupied` | `UserCheck` | ok | Seat in use |
| `vacant` | `Armchair` | neutral | Seat empty (timer running) |
| `vacancy_alert` is an **event**, not a state | `BellRing` | danger | Vacant beyond threshold |
| `uncertain` | `HelpCircle` | warn | Low confidence, no alert possible |
| `transitioning` | `Loader` (static if reduced-motion) | warn | Verifying change |
| `camera_unavailable` | `VideoOff` | neutral+warn outline | **No valid frames. This is NOT vacancy.** |
| `model_error` | `AlertTriangle` | danger | Inference failed |

Never display "vacant" when the state is `camera_unavailable`, `uncertain` or `model_error`. Add a unit test for this.

## VIDEO + ROI (the most delicate part, so be precise)
- Display frames from `GET /api/v1/stream/{camera_id}.mjpg` in an `<img>`. Fall back to WebSocket binary frames only if the contract says so.
- Put a `<canvas>` or SVG overlay on the **rendered video rectangle** (account for `object-fit: contain` letterboxing). Compute the true displayed rect from `naturalWidth/naturalHeight` and `ResizeObserver`.
- Store ROI points as **normalized `[0..1]` coordinates relative to the original frame**. Convert to and from pixels only at draw and pointer time. A resize must never shift the ROI. Write unit tests for the conversion (letterboxed wide, letterboxed tall, resized).
- Rectangle = 4 points saved as a polygon (the contract uses polygons only). Polygon needs ≥3 points, no self-intersection (validate), and clamp to [0,1].
- Pointer Events (mouse + touch + pen). Handles at least 14px with a larger invisible hit target. Keyboard: arrows nudge 1px (Shift = 10px), Delete removes the selected point, Esc cancels.
- Draw the live ROI in the **state color** (thin 2px line, 12% fill). While editing, use `--accent` with a dashed stroke.
- After Save, call the API and show the returned crop thumbnail so the user can verify what the model sees.

## REAL-TIME DATA
- One WebSocket client module with: auto-reconnect (exponential backoff 0.5s → 10s with jitter), heartbeat (ping/pong per the contract), message validation (Zod, drop and count invalid messages), and a typed event emitter.
- On disconnect: keep the last frame, overlay "Connection lost, reconnecting…", and mark all seat states **stale** (gray, with an "as of HH:MM:SS" label). Never show stale data as current.
- Use `frame_id`/`timestamp` from `inference` messages to display latency honestly. Do not fabricate numbers. Show `-` when no data exists.
- Throttle chart updates (about 2 Hz) and keep a ring buffer of 300 points per series.

## ALERTS + SOUND
- `AlertBanner` appears on a `vacancy_confirmed` event: seat name, vacant duration, **Acknowledge** and **Snooze 5m** buttons. It stays until acknowledged, but does not stack duplicates (dedupe by `event_id` / `alert_id`).
- Sound: synthesize with the **Web Audio API** (two-tone beep, no asset files). Browsers block autoplay, so show a one-time "Enable alert sound" prompt tied to a user click that creates and resumes the `AudioContext`. Show a persistent speaker icon state (enabled, muted, blocked).
- Rules: play only on `severity >= warning` alert events, never on routine state changes. Respect the cooldown (the backend already dedupes, but also guard on the client with the same `alert_id`). Repeat at most every N seconds (setting), and stop on acknowledge. If audio is blocked, show a visible banner instead of failing silently.
- Also send a browser Notification only if the user opts in (optional).

## HONESTY RULES
- Anything simulated (synthetic video, demo detections) must carry a visible **SIMULATED** badge on the affected panel, taken from the backend's `simulated` flag.
- Add a footer note on `/system`: "Accuracy has not been validated on your footage. Evaluate before relying on alerts for safety-critical use."
- Do not invent metrics, accuracy or uptime numbers.

## DEV WITHOUT BACKEND
Create `lib/mock/` that implements the contract and is enabled **only** with `NEXT_PUBLIC_USE_MOCK=true`. When active, the UI shows the SIMULATED badge. It must never be the default.

## ENV + COMMANDS
`NEXT_PUBLIC_API_BASE=http://localhost:8000` and `NEXT_PUBLIC_WS_BASE=ws://localhost:8000`.
`npm run dev`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm test`.

## TESTING (keep it lean, but cover the essentials)
Vitest + React Testing Library:
1. ROI coordinate conversion (letterbox and resize cases)
2. State → badge mapping (including that `camera_unavailable` is never shown as vacant)
3. WebSocket client: reconnect, invalid-message drop, stale marking
4. Alert dedupe and audio-unlock logic (mock `AudioContext`)
5. One Playwright smoke test (optional): load the page with the mock, draw an ROI and see a state change

## WORKING STYLE (save tokens, get quality)
- **Plan in ≤15 lines, then build.** No long preambles or restating this prompt.
- Build in this order: (1) tokens, shell, theme; (2) API/WS client + Zod types; (3) Live page + ROI editor; (4) Overview; (5) Events + alerts + sound; (6) System + charts; (7) Settings; (8) tests; (9) polish.
- Generate components with shadcn CLI where one exists instead of hand-writing primitives.
- Do not paste whole files back in chat. Report only a short changelog.
- Run `typecheck` and `lint` after each milestone and fix errors immediately.
- Do not add libraries beyond the stack without justification.
- No `any`, no `// @ts-ignore`, no unused dependencies.

## DONE WHEN
- `npm run build`, `lint`, `typecheck` and `test` pass.
- All six pages render with real backend data, with loading, empty and error states.
- An ROI drawn at one window size stays aligned at another.
- Sound works after the user enables it. Duplicate alerts do not stack.
- Disconnect and camera loss never look like vacancy.
- Final reply: file tree, run steps, a list of any gaps (`INTEGRATION-GAPS.md`) and screenshots or descriptions of each page.
