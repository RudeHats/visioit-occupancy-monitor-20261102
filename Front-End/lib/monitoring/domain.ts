import { z } from "zod"

export const seatStateSchema = z.enum([
  "occupied",
  "vacant",
  "uncertain",
  "transitioning",
  "camera_unavailable",
  "model_error",
])

export type SeatState = z.infer<typeof seatStateSchema>

export const eventTypeSchema = z.enum([
  "vacancy_confirmed",
  "state_changed",
  "seat_occupied",
  "seat_vacant",
  "camera_unavailable",
  "camera_recovered",
  "model_error",
])

export type EventType = z.infer<typeof eventTypeSchema>

export type EventSeverity = "info" | "warning" | "critical"

export type NormalizedPoint = [number, number]

export type Seat = {
  id: string
  name: string
  state: SeatState
  confidence: number | null
  durationLabel: string
  cameraId: string
  thumbnailPosition: string
  vacantForSeconds?: number
  polygon?: NormalizedPoint[]
}

export type MonitorEvent = {
  id: string
  alertId?: string | null
  type: EventType
  severity: EventSeverity
  seatId: string
  seatName: string
  timeLabel: string
  ageMinutes?: number
  description: string
  vacantForSeconds?: number
  acknowledged: boolean
  snoozedUntil?: number
}

export const previewSettingsSchema = z.object({
  source: z.enum(["usb", "rtsp", "file", "synthetic"]),
  sourceUrl: z.string().default(""),
  usbIndex: z.number().int().min(0).default(0),
  vacancyDurationSeconds: z.number().int().min(1).max(86400),
  confidenceThreshold: z.number().min(0).max(1),
  alertCooldownSeconds: z.number().int().min(0).max(3600),
  soundEnabled: z.boolean(),
  soundVolume: z.number().int().min(0).max(100),
})

export type PreviewSettings = z.infer<typeof previewSettingsSchema>
