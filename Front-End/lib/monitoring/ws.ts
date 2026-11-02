import { z } from "zod"
import { backendHelloSchema, backendInferenceSchema, backendMetricsSchema, backendStateChangeSchema, backendEventSchema, backendHealthMessageSchema } from "./contract"

export const wsEnvelopeSchema = z.object({
  type: z.string(),
  ts: z.string(),
  t_ms: z.number(),
  data: z.unknown(),
})

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendHelloSchema,
  }),
  z.object({
    type: z.literal("inference"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendInferenceSchema,
  }),
  z.object({
    type: z.literal("state_change"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendStateChangeSchema,
  }),
  z.object({
    type: z.literal("event"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendEventSchema,
  }),
  z.object({
    type: z.literal("metrics"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendMetricsSchema,
  }),
  z.object({
    type: z.literal("health"),
    ts: z.string(),
    t_ms: z.number(),
    data: backendHealthMessageSchema,
  }),
])

export type WsMessage = z.infer<typeof wsMessageSchema>
export type WsMessageData =
  | { kind: "hello"; data: z.infer<typeof backendHelloSchema> }
  | { kind: "inference"; data: z.infer<typeof backendInferenceSchema> }
  | { kind: "state_change"; data: z.infer<typeof backendStateChangeSchema> }
  | { kind: "event"; data: z.infer<typeof backendEventSchema> }
  | { kind: "metrics"; data: z.infer<typeof backendMetricsSchema> }
  | { kind: "health"; data: z.infer<typeof backendHealthMessageSchema> }

export type BackendSocketHandlers = {
  onHello: (hello: z.infer<typeof backendHelloSchema>) => void
  onInference: (inference: z.infer<typeof backendInferenceSchema>) => void
  onStateChange: (change: z.infer<typeof backendStateChangeSchema>) => void
  onEvent: (event: z.infer<typeof backendEventSchema>) => void
  onMetrics: (metrics: z.infer<typeof backendMetricsSchema>) => void
  onHealth: (health: z.infer<typeof backendHealthMessageSchema>) => void
  onOpen: () => void
  onClose: (code: number, reason: string) => void
}

type SocketStatus = "closed" | "connecting" | "open" | "reconnecting"

/**
 * WebSocket client for `GET /api/v1/ws` (INTEGRATION-INSTRUCTIONS.md §6).
 * Validates every inbound message against the contract, pings every 10 s,
 * and reconnects with exponential backoff (0.5 s → 10 s, with jitter).
 */
export class BackendSocket {
  private socket: WebSocket | null = null
  private handlers: BackendSocketHandlers
  private shouldRun = true
  private status: SocketStatus = "closed"
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  private url: string

  constructor(url: string, handlers: BackendSocketHandlers) {
    this.url = url
    this.handlers = handlers
  }

  connect(): void {
    if (!this.shouldRun || this.status === "open") return
    if (this.status === "connecting") return
    this.status = "connecting"
    this.openSocket()
  }

  disconnect(): void {
    this.shouldRun = false
    this.status = "closed"
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      socket.onclose = null
      socket.close()
    }
  }

  send(message: { type: "ping" }): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
      return true
    }
    return false
  }

  private openSocket(): void {
    if (!this.shouldRun) return
    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      this.status = "open"
      this.attempt = 0
      this.heartbeatTimer = setInterval(() => this.send({ type: "ping" }), 10_000)
      this.handlers.onOpen()
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(event.data)
        const result = wsMessageSchema.safeParse(parsed)
        if (!result.success) return
        const message = result.data as { type: string } & Record<string, unknown>
        const data = message.data as Record<string, unknown>
        switch (message.type) {
          case "hello":
            this.handlers.onHello(data as z.infer<typeof backendHelloSchema>)
            break
          case "inference":
            this.handlers.onInference(data as z.infer<typeof backendInferenceSchema>)
            break
          case "state_change":
            this.handlers.onStateChange(data as z.infer<typeof backendStateChangeSchema>)
            break
          case "event":
            this.handlers.onEvent(data as z.infer<typeof backendEventSchema>)
            break
          case "metrics":
            this.handlers.onMetrics(data as z.infer<typeof backendMetricsSchema>)
            break
          case "health":
            this.handlers.onHealth(data as z.infer<typeof backendHealthMessageSchema>)
            break
          default:
            break
        }
      } catch {
        // Malformed frames are dropped; the next valid message recovers.
      }
    }

    socket.onclose = (event: CloseEvent) => {
      this.status = "closed"
      this.teardownHeartbeat()
      if (this.socket === socket) this.socket = null
      this.handlers.onClose(event.code, event.reason)
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      socket.close()
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return
    const delayMs = Math.min(10_000, 500 * 2 ** this.attempt) * (0.8 + Math.random() * 0.4)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.status = "reconnecting"
      this.openSocket()
    }, delayMs)
  }

  private teardownHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
