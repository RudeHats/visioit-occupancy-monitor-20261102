import { z } from "zod"
import { seatStateSchema } from "./domain"

/** Mirrors `GET /api/v1/health` from INTEGRATION-INSTRUCTIONS.md §5.1 */
export const backendHealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  backend_version: z.string(),
  contract_version: z.string(),
  uptime_s: z.number(),
  simulated: z.boolean(),
  camera: z.object({
    state: z.string(),
    last_frame_age_ms: z.number().nullable(),
    message: z.string().nullable(),
  }),
  model: z.object({
    state: z.string(),
    name: z.string(),
    message: z.string().nullable(),
  }),
})

export type BackendHealth = z.infer<typeof backendHealthSchema>

/** Mirrors `GET /api/v1/system/model` from INTEGRATION-INSTRUCTIONS.md §5.1 */
export const backendModelSchema = z.object({
  name: z.string(),
  version: z.string(),
  task: z.string(),
  device: z.string(),
  classes_used: z.array(z.string()),
  checkpoint: z.string,
  license: z.string(),
  simulated: z.boolean(),
  mode: z.string,
})

export type BackendModel = z.infer<typeof backendModelSchema>

/** Mirrors the `metrics` message / `GET /api/v1/system/metrics` from §6.4 and §5.1 */
export const backendMetricsSchema = z.object({
  capture_fps: z.number().nullable().optional(),
  processing_fps: z.number().nullable().optional(),
  inference_ms: z.object({
    p50: z.number().nullable().optional(),
    p95: z.number().nullable().optional(),
    p99: z.number().nullable().optional(),
    last: z.number().nullable().optional(),
  }),
  pipeline_ms: z.object({
    p50: z.number().nullable().optional(),
    p95: z.number().nullable().optional(),
  }),
  dropped_frames: z.number(),
  inference_errors: z.number(),
  confidence_hist: z.object({
    bins: z.array(z.number()),
    counts: z.array(z.number()),
  }),
  device: z.string(),
  simulated: z.boolean(),
})

export type BackendMetrics = z.infer<typeof backendMetricsSchema>

/** Mirrors `GET /api/v1/settings` / `PUT /api/v1/settings` keys from §5.4 */
export const backendSettingsSchema = z.object({
  vacancy_seconds: z.number(),
  cooldown_seconds: z.number(),
  occupied_conf: z.number(),
  low_conf: z.number(),
  min_overlap_occ: z.number(),
  min_overlap_any: z.number(),
  enter_occupied: z.number(),
  exit_occupied: z.number(),
  smoothing_tau_s: z.number(),
  confirm_s: z.number(),
  show_transition_s: z.number(),
  uncertain_hold_s: z.number(),
  uncertain_warn_seconds: z.number(),
  stale_timeout_s: z.number(),
  recovery_grace_s: z.number(),
  crop_padding: z.number(),
  inference_mode: z.string(),
  target_inference_fps: z.number(),
  min_sharpness: z.number(),
})

export type BackendSettings = z.infer<typeof backendSettingsSchema>

/** A seat as returned by `GET /api/v1/seats` / `POST /api/v1/seats` (§5.3). */
export const backendSeatSchema = z.object({
  seat_id: z.string(),
  name: z.string(),
  state: seatStateSchema,
  confidence: z.number().nullable(),
  vacant_for_s: z.number(),
  polygon: z.array(z.array(z.number()).length(2)),
  enabled: z.boolean(),
  camera_id: z.string(),
  reference_frame_size: z.array(z.number()).length(2).nullable().optional(),
})

export type BackendSeat = z.infer<typeof backendSeatSchema>

/** An event as emitted on the WebSocket `event` message / served by `GET /api/v1/events` (§6.5, §5.5). */
export const backendEventSchema = z.object({
  event_id: z.string(),
  alert_id: z.string().nullable(),
  type: z.string(),
  severity: z.string(),
  seat_id: z.string(),
  camera_id: z.string(),
  message: z.string(),
  sound: z.boolean(),
  simulated: z.boolean(),
  created_at: z.string(),
  vacant_duration_s: z.number().nullable().optional(),
  episode_id: z.string().optional(),
})

export type BackendEvent = z.infer<typeof backendEventSchema>

/** An `inference` message payload from `GET /api/v1/ws` (§6.2). */
export const backendInferenceSchema = z.object({
  seat_id: z.string(),
  camera_id: z.string(),
  frame_id: z.number(),
  raw_label: z.string(),
  state: z.string(),
  confidence: z.number().nullable(),
  score_smoothed: z.number(),
  person_conf: z.number(),
  overlap: z.number(),
  boxes: z.array(
    z.object({
      cls: z.string(),
      conf: z.number(),
      xyxy_norm: z.array(z.number()).length(4),
    }),
  ),
  quality: z.object({
    blur: z.number(),
    brightness: z.number(),
    valid_roi_pixels: z.number(),
    ok: z.boolean(),
  }),
  vacant_for_s: z.number(),
  latency: z.object({
    inference_ms: z.number(),
    crop_ms: z.number,
    pipeline_ms: z.number,
  }),
  simulated: z.boolean(),
})

export type BackendInference = z.infer<typeof backendInferenceSchema>

/** The `hello` message payload sent by the backend on WebSocket connect (§6.1). */
export const backendHelloSchema = z.object({
  contract_version: z.string(),
  backend_version: z.string(),
  simulated: z.boolean(),
  snapshot: z.object({
    seats: z.array(backendSeatSchema),
    settings: backendSettingsSchema,
    health: backendHealthSchema,
  }),
})

export type BackendHello = z.infer<typeof backendHelloSchema>

/** A `state_change` message payload from `GET /api/v1/ws` (§6.3). */
export const backendStateChangeSchema = z.object({
  seat_id: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
  since: z.string(),
})

export type BackendStateChange = z.infer<typeof backendStateChangeSchema>

/** A `health` message payload from `GET /api/v1/ws` (§6.6) — same shape as the REST health. */
export const backendHealthMessageSchema = backendHealthSchema

export type BackendHealthMessage = BackendHealth
