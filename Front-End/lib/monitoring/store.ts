"use client"

import { create } from "zustand"
import { previewSettingsSchema, type MonitorEvent, type NormalizedPoint, type PreviewSettings, type Seat, type SeatState } from "./domain"
import { demoEvents, demoSeats } from "../mock/preview-data"
import { dedupeAlerts } from "./alerts"
import { stopAlertTone } from "./alert-audio"
import { BackendSocket, type BackendSocketHandlers } from "./ws"
import {
  api,
  WS_BASE,
  eventFromBackend,
  inferenceToSeatState,
  seatFromBackend,
  settingsFromBackend,
} from "./api"
import type { BackendHealth, BackendInference, BackendMetrics, BackendModel } from "./contract"

export type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting"

export const mockEnabled = process.env.NEXT_PUBLIC_USE_MOCK === "true"

export const defaultPreviewSettings: PreviewSettings = {
  source: "synthetic",
  sourceUrl: "",
  usbIndex: 0,
  vacancyDurationSeconds: 180,
  confidenceThreshold: 0.78,
  alertCooldownSeconds: 300,
  soundEnabled: false,
  soundVolume: 62,
}

export const initialRegion: NormalizedPoint[] = [
  [0.22, 0.34],
  [0.47, 0.34],
  [0.47, 0.87],
  [0.22, 0.87],
]

let demoEventSequence = 1
let backendSocket: BackendSocket | null = null
let connectionGeneration = 0
const SETTINGS_KEY = "visioit.monitoring.settings.v2"
function loadSavedSettings(): PreviewSettings {
  if (typeof window === "undefined") return defaultPreviewSettings
  try {
    const value = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null")
    const parsed = previewSettingsSchema.safeParse(value)
    return parsed.success ? parsed.data : defaultPreviewSettings
  } catch { return defaultPreviewSettings }
}

type MonitoringStore = {
  seats: Seat[]
  events: MonitorEvent[]
  settings: PreviewSettings
  region: NormalizedPoint[]
  savedRegion: NormalizedPoint[]
  soundUnlocked: boolean
  soundBlocked: boolean
  muted: boolean
  connection: { status: ConnectionStatus; detail?: string }
  metrics: BackendMetrics | null
  health: BackendHealth | null
  modelInfo: BackendModel | null
  inferenceBySeat: Record<string, BackendInference>
  acknowledgeEvent: (id: string) => void
  snoozeEvent: (id: string) => void
  updateSettings: (settings: PreviewSettings) => void
  setSoundUnlocked: (unlocked: boolean) => void
  setSoundBlocked: (blocked: boolean) => void
  toggleMuted: () => void
  setRegion: (region: NormalizedPoint[]) => void
  saveRegion: (points: NormalizedPoint[]) => void
  restoreRegion: () => void
  triggerDemoAlert: () => MonitorEvent | null
  runDemoAlert: () => Promise<MonitorEvent | null>
  setSeatState: (id: string, state: SeatState) => void
  setConnection: (status: ConnectionStatus, detail?: string) => void
  setSeats: (seats: Seat[]) => void
  updateSeat: (id: string, patch: Partial<Seat>) => void
  pushEvent: (event: MonitorEvent) => void
  setMetrics: (metrics: BackendMetrics | null) => void
  setHealth: (health: BackendHealth | null) => void
  setModelInfo: (model: BackendModel | null) => void
  setInferenceBySeat: (seatId: string, inference: BackendInference) => void
  connectBackend: () => Promise<boolean>
  disconnectBackend: () => void
  switchSource: (source: string) => Promise<{ camera_id: string; state: string; frame_size: [number, number] | null } | undefined>
  startPolling: () => () => void
}

export const useMonitoringStore = create<MonitoringStore>()((set, get) => ({
  seats: mockEnabled ? demoSeats : [],
  events: mockEnabled ? demoEvents : [],
  settings: loadSavedSettings(),
  region: initialRegion,
  savedRegion: initialRegion,
  soundUnlocked: false,
  soundBlocked: false,
  muted: false,
  connection: { status: "offline" },
  metrics: null,
  health: null,
  modelInfo: null,
  inferenceBySeat: {},

  acknowledgeEvent: (id) => {
    stopAlertTone()
    set((state) => ({
      events: state.events.map((event) =>
        event.id === id ? { ...event, acknowledged: true } : event,
      ),
    }))
    void api.alertAck(id).catch(() => undefined)
  },

  snoozeEvent: (id) => {
    stopAlertTone()
    const state = get()
    const event = state.events.find((candidate) => candidate.id === id)
    set((state) => ({
      events: state.events.map((candidate) =>
        candidate.id === id ? { ...candidate, snoozedUntil: Date.now() + 5 * 60 * 1000 } : candidate,
      ),
    }))
    if (event?.alertId) {
      void api.alertSnooze(event.alertId, 300).catch(() => undefined)
    }
  },

  updateSettings: (settings) => { set({ settings }); if (typeof window !== "undefined") window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) },

  setSoundUnlocked: (soundUnlocked) => set({ soundUnlocked, soundBlocked: false }),

  setSoundBlocked: (soundBlocked) => set({ soundBlocked }),

  toggleMuted: () => set((state) => ({ muted: !state.muted })),

  setRegion: (region) => set({ region }),

  saveRegion: (region) => set({ region, savedRegion: region }),

  restoreRegion: () => set({ region: get().savedRegion }),

  triggerDemoAlert: () => {
    if (!mockEnabled) return null

    const existing = get().events.find(
      (event) => event.type === "vacancy_confirmed" && !event.acknowledged,
    )
    if (existing) return existing

    const event: MonitorEvent = {
      id: `demo-vacancy-${Date.now()}-${demoEventSequence++}`,
      type: "vacancy_confirmed",
      severity: "warning",
      seatId: "A-04",
      seatName: "A-04 · Center row",
      timeLabel: "Just now",
      ageMinutes: 0,
      description: "Vacant beyond the local preview threshold.",
      vacantForSeconds: 242,
      acknowledged: false,
    }

    set((state) => ({ events: dedupeAlerts([event, ...state.events]) }))
    return event
  },

  runDemoAlert: async () => {
    if (mockEnabled) return get().triggerDemoAlert()

    const event = await api.demoTrigger()
    const monitorEvent = eventFromBackend(event, get().seats)
    if (monitorEvent) get().pushEvent(monitorEvent)
    return monitorEvent
  },

  setSeatState: (id, stateValue) =>
    set((state) => ({
      seats: state.seats.map((seat) =>
        seat.id === id ? { ...seat, state: stateValue } : seat,
      ),
    })),

  setConnection: (status, detail) => set({ connection: { status, detail } }),

  setSeats: (seats) => set({ seats }),

  updateSeat: (id, patch) =>
    set((state) => ({
      seats: state.seats.map((seat) => (seat.id === id ? { ...seat, ...patch } : seat)),
    })),

  pushEvent: (event) =>
    set((state) => ({
      events: dedupeAlerts([event, ...state.events]).slice(0, 500),
    })),

  switchSource: async (source) => {
    if (!source) return
    try {
      const result = await api.sourcesSelect({
        type: source,
        url: source === "rtsp" ? get().settings.sourceUrl : undefined,
        usb_index: source === "usb" ? get().settings.usbIndex : undefined,
        loop: true,
        target_fps: 15,
      })
      get().setHealth(await api.health())
      return result
    } catch (error) {
      throw error
    }
  },

  setMetrics: (metrics) => set({ metrics }),

  setHealth: (health) => set({ health }),

  setModelInfo: (model) => set({ modelInfo: model }),

  setInferenceBySeat: (seatId, inference) =>
    set((state) => ({ inferenceBySeat: { ...state.inferenceBySeat, [seatId]: inference } })),

  connectBackend: async () => {
    const generation = ++connectionGeneration
    const existing = backendSocket
    if (existing) {
      existing.disconnect()
      backendSocket = null
    }
    get().setConnection("connecting")
    try {
      const health = await api.health()
      if (generation !== connectionGeneration) return false
      get().setHealth(health)
      get().setConnection("connected")
      const model = await api.model().catch(() => null)
      if (generation !== connectionGeneration) return false
      if (model) get().setModelInfo(model)
      const saved = get().settings
      if (typeof window !== "undefined" && window.localStorage.getItem(SETTINGS_KEY)) {
        await api.sourcesSelect({ type: saved.source, url: saved.source === "rtsp" ? saved.sourceUrl : undefined, usb_index: saved.source === "usb" ? saved.usbIndex : undefined, loop: true, target_fps: 15 }).catch((error: unknown) => {
          get().setConnection("connected", error instanceof Error ? `Camera configuration: ${error.message}` : "Camera configuration could not be restored")
        })
      }
      if (health.status !== "ok" && health.status !== "degraded") {
        get().setConnection("reconnecting", health.status)
        return false
      }
      if (generation !== connectionGeneration) return false

      // Mark connected as soon as the backend responds to REST —
      // WebSocket is a bonus for real-time push, not a hard requirement.
      get().setConnection("connected")

      let wsResolve: (() => void) | null = null
      const wsPromise = new Promise<void>((resolve) => {
        wsResolve = resolve
      })

      const handlers: BackendSocketHandlers = {
        onHello: (hello) => {
          get().setHealth(hello.snapshot.health)
          get().setSeats(hello.snapshot.seats.map(seatFromBackend))
          const settings = settingsFromBackend(hello.snapshot.settings)
          const saved = get().settings
          set({ settings: { ...saved, vacancyDurationSeconds: settings.vacancyDurationSeconds, confidenceThreshold: settings.confidenceThreshold, alertCooldownSeconds: settings.alertCooldownSeconds } })
          const firstSeat = hello.snapshot.seats[0]
          if (firstSeat) {
            const region = firstSeat.polygon.map(([x, y]) => [x, y] as NormalizedPoint)
            if (region.length > 0) get().setRegion(region)
          }
        },
        onInference: (inference) => {
          const { state, confidence, vacantForSeconds } = inferenceToSeatState(inference)
          get().updateSeat(inference.seat_id, { state, confidence, vacantForSeconds })
          get().setInferenceBySeat(inference.seat_id, inference)
        },
        onStateChange: (change) => {
          get().setSeatState(change.seat_id, change.to as SeatState)
        },
        onEvent: (event) => {
          const monitorEvent = eventFromBackend(event, get().seats)
          if (monitorEvent) get().pushEvent(monitorEvent)
        },
        onMetrics: (metrics) => get().setMetrics(metrics),
        onHealth: (health) => get().setHealth(health),
        onOpen: () => {
          if (wsResolve) {
            wsResolve()
            wsResolve = null
          }
        },
        onClose: () => {
          // WebSocket closed but REST polling still works — don't mark offline
          const status = get().connection.status
          if (status === "offline") return
          // Keep connected status, polling continues
        },
      }

      const socket = new BackendSocket(`${WS_BASE}/api/v1/ws`, handlers)
      backendSocket = socket
      socket.connect()

      // Don't block on WebSocket — REST is already working.
      try {
        await Promise.race([wsPromise, new Promise((_, rej) => setTimeout(() => rej(new Error("WS timeout")), 5000))])
      } catch {
        // WebSocket didn't open in time; continue with REST-only mode
      }

      return true
    } catch (error) {
      if (generation !== connectionGeneration) return false
      get().setConnection("offline", error instanceof Error ? `Backend connection: ${error.message}` : "Backend unreachable")
      return false
    }
  },

  disconnectBackend: () => {
    connectionGeneration += 1
    backendSocket?.disconnect()
    backendSocket = null
    get().setConnection("offline")
  },

  startPolling: () => {
    const seatsInterval = setInterval(async () => {
      try {
        const seats = await api.seats()
        get().setSeats(seats.map(seatFromBackend))
      } catch {
        // silently fail; polling will retry
      }
    }, 2000)

    const healthInterval = setInterval(async () => {
      try {
        const health = await api.health()
        get().setHealth(health)
        get().setConnection("connected")
        const model = await api.model().catch(() => null)
        if (model) get().setModelInfo(model)
      } catch {
        get().setConnection("reconnecting", "Backend unreachable; retrying")
      }
    }, 5000)

    const metricsInterval = setInterval(async () => {
      try {
        const metrics = await api.metrics()
        get().setMetrics(metrics)
      } catch {
        // silently fail
      }
    }, 2000)

    return () => {
      clearInterval(seatsInterval)
      clearInterval(healthInterval)
      clearInterval(metricsInterval)
    }
  },
}))
