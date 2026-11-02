import type { BackendEvent, BackendHealth, BackendInference, BackendMetrics, BackendModel, BackendSettings, BackendSeat } from "./contract"
import { eventTypeSchema, previewSettingsSchema, seatStateSchema, type EventSeverity, type EventType, type MonitorEvent, type NormalizedPoint, type PreviewSettings, type Seat, type SeatState } from "./domain"

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "/backend"
export const WS_BASE = process.env.NEXT_PUBLIC_WS_BASE ?? (typeof window === "undefined"
  ? "ws://127.0.0.1:8000"
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/backend`)

export class ApiError extends Error {
  readonly code: string
  readonly hint: string
  readonly retryable: boolean
  readonly status: number

  constructor(code: string, message: string, hint: string, status: number, retryable: boolean) {
    super(message)
    this.code = code
    this.hint = hint
    this.status = status
    this.retryable = retryable
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })

  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? ((body as { error?: { code?: string; message?: string; hint?: string; retryable?: boolean } }).error ?? null)
        : null
    throw new ApiError(
      error?.code ?? "INTERNAL",
      error?.message ?? `Request failed with status ${response.status}`,
      error?.hint ?? "",
      response.status,
      error?.retryable ?? false,
    )
  }

  return body as T
}

export const api = {
  health: (): Promise<BackendHealth> => request<BackendHealth>("/api/v1/health"),
  model: (): Promise<BackendModel> => request<BackendModel>("/api/v1/system/model"),
  metrics: (): Promise<BackendMetrics> => request<BackendMetrics>("/api/v1/system/metrics"),

  sourcesSelect: (source: { type: string; usb_index?: number; url?: string; path?: string; loop?: boolean; target_fps?: number; resolution?: [number, number] }): Promise<{ camera_id: string; state: string; frame_size: [number, number] | null }> =>
    request("/api/v1/sources/select", {
      method: "POST",
      body: JSON.stringify(source),
    }),
  sourceTest: (source: { type: string; usb_index?: number; url?: string; path?: string; loop?: boolean; target_fps?: number }) =>
    request<{ opened: boolean; frames: number; measured_fps: number; first_frame_ms: number | null; decode_errors: number; frame_size: [number, number] | null }>("/api/v1/sources/test", { method: "POST", body: JSON.stringify({ ...source, duration_s: 2 }) }),
  sourcesStop: (): Promise<{ state: string }> => request("/api/v1/sources/stop", { method: "POST" }),

  seats: (): Promise<BackendSeat[]> => request<BackendSeat[]>("/api/v1/seats"),
  seatCreate: (input: { seat_id: string; name: string; polygon: NormalizedPoint[]; camera_id?: string; enabled?: boolean }): Promise<{ seat_id: string }> =>
    request("/api/v1/seats", { method: "POST", body: JSON.stringify(input) }),
  seatUpdate: (seatId: string, input: { seat_id: string; name: string; polygon: NormalizedPoint[]; camera_id?: string; enabled?: boolean }): Promise<{ seat_id: string }> =>
    request(`/api/v1/seats/${seatId}`, { method: "PUT", body: JSON.stringify(input) }),
  seatDelete: (seatId: string): Promise<{ deleted: boolean }> => request(`/api/v1/seats/${seatId}`, { method: "DELETE" }),
  cropPreview: (seatId: string): Promise<{ image_jpeg_base64: string; crop_box_px: [number, number, number, number]; frame_size: [number, number] }> =>
    request(`/api/v1/seats/${seatId}/crop-preview`, { method: "POST" }),

  settings: (): Promise<BackendSettings> => request<BackendSettings>("/api/v1/settings"),
  settingsPut: (body: Record<string, unknown>): Promise<BackendSettings> => request<BackendSettings>("/api/v1/settings", { method: "PUT", body: JSON.stringify(body) }),

  events: (params: { limit?: number; seat_id?: string; type?: string; since?: string }): Promise<BackendEvent[]> =>
    request<BackendEvent[]>(`/api/v1/events?${new URLSearchParams({ ...(params.limit ? { limit: String(params.limit) } : {}), ...(params.seat_id ? { seat_id: params.seat_id } : {}), ...(params.type ? { type: params.type } : {}) })}`),
  alertAck: (alertId: string): Promise<{ acknowledged: boolean }> => request(`/api/v1/alerts/${alertId}/ack`, { method: "POST" }),
  alertSnooze: (alertId: string, seconds: number): Promise<{ snoozed: boolean }> => request(`/api/v1/alerts/${alertId}/snooze`, { method: "POST", body: JSON.stringify({ seconds }) }),
  demoTrigger: (): Promise<BackendEvent> => request<BackendEvent>("/api/v1/demo/trigger", { method: "POST" }),
}

export function streamUrl(cameraId: string): string {
  return `${API_BASE}/api/v1/stream/${cameraId}.mjpg`
}

/* ───────────────────────────── mappers: backend → UI ───────────────────────────── */

function toSeatState(value: string): SeatState {
  return seatStateSchema.safeParse(value).success ? (value as SeatState) : "transitioning"
}

function toEventType(value: string): EventType | null {
  return eventTypeSchema.safeParse(value).success ? (value as EventType) : null
}

export function seatFromBackend(raw: BackendSeat): Seat {
  return {
    id: raw.seat_id,
    name: raw.name,
    state: toSeatState(raw.state),
    confidence: raw.confidence,
    durationLabel: formatDurationLabel(raw.vacant_for_s),
    cameraId: raw.camera_id,
    thumbnailPosition: "50% 50%",
    vacantForSeconds: raw.vacant_for_s,
    polygon: raw.polygon?.map(([x, y]) => [x, y] as NormalizedPoint),
  }
}

export function eventFromBackend(raw: BackendEvent, seats: Seat[] = []): MonitorEvent | null {
  const type = toEventType(raw.type)
  if (!type) return null

  const seat = seats.find((candidate) => candidate.id === raw.seat_id)
  const createdAtMs = Date.parse(raw.created_at)
  const ageMinutes = Number.isNaN(createdAtMs) ? 0 : Math.max(0, (Date.now() - createdAtMs) / 60_000)

  const event: MonitorEvent = {
    id: raw.alert_id ?? raw.event_id,
    alertId: raw.alert_id ?? null,
    type,
    severity: (["info", "warning", "critical"] as EventSeverity[]).includes(raw.severity as EventSeverity)
      ? (raw.severity as EventSeverity)
      : "warning",
    seatId: raw.seat_id ?? "system",
    seatName: seat?.name ?? raw.seat_id ?? "System",
    timeLabel: formatTimeLabel(raw.created_at),
    ageMinutes: Math.round(ageMinutes * 10) / 10,
    description: raw.message,
    vacantForSeconds: raw.vacant_duration_s ?? undefined,
    acknowledged: false,
    snoozedUntil: undefined,
  }

  if (type === "vacancy_confirmed") event.acknowledged = false
  return event
}

export function settingsFromBackend(raw: BackendSettings): PreviewSettings {
  const parsed = previewSettingsSchema.safeParse({
    source: "synthetic", sourceUrl: "", usbIndex: 0,
    vacancyDurationSeconds: Math.round(raw.vacancy_seconds),
    confidenceThreshold: raw.occupied_conf,
    alertCooldownSeconds: Math.round(raw.cooldown_seconds),
    soundEnabled: true,
    soundVolume: 80,
  })
  return parsed.success
    ? parsed.data
    : {
        source: "synthetic", sourceUrl: "", usbIndex: 0,
        vacancyDurationSeconds: 10,
        confidenceThreshold: 0.45,
        alertCooldownSeconds: 120,
        soundEnabled: true,
        soundVolume: 80,
      }
}

export function inferenceToSeatState(inference: BackendInference): { state: SeatState; confidence: number | null; vacantForSeconds?: number } {
  const seatState = toSeatState(inference.state)
  return {
    state: seatState,
    confidence: inference.confidence,
    vacantForSeconds: inference.vacant_for_s,
  }
}

/* ───────────────────────────── formatters ───────────────────────────── */

export function formatDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`
}

export function formatTimeLabel(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return "Just now"
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSeconds < 60) return "Just now"
  const minutes = Math.floor(diffSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
