"use client"

import { useEffect, useRef } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/monitoring/api"
import { useMonitoringStore, mockEnabled } from "@/lib/monitoring/store"

export function BackendConnectionProvider({ children }: { children: React.ReactNode }) {
  const connectBackend = useMonitoringStore((state) => state.connectBackend)
  const startPolling = useMonitoringStore((state) => state.startPolling)
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const connectionDetail = useMonitoringStore((state) => state.connection.detail)
  const setConnection = useMonitoringStore((state) => state.setConnection)
  const stopPollingRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (mockEnabled) return
    if (connectionStatus === "connected") return

    let attempts = 0
    let cancelled = false

    const tryConnect = async () => {
      if (cancelled) return
      attempts += 1

      let healthOk = false
      let fetchErr: string | undefined
      try {
        const res = await fetch("http://127.0.0.1:8000/api/v1/health")
        if (res.ok) {
          const health = await res.json()
          healthOk = health.status === "ok"
        }
      } catch (e) {
        fetchErr = e instanceof Error ? e.message : String(e)
      }

      if (cancelled) return

      if (healthOk) {
        const store = useMonitoringStore.getState()
        store.setConnection("connected")
        const health = await api.health().catch(() => null)
        if (health) store.setHealth(health)
        if (!stopPollingRef.current) {
          stopPollingRef.current = startPolling()
        }
        void connectBackend()
      } else {
        setConnection("offline", fetchErr ?? "health check failed")
        if (attempts < 10) {
          setTimeout(tryConnect, Math.min(2000 * 2 ** attempts, 10000))
        }
      }
    }

    const timer = setTimeout(() => {
      tryConnect()
    }, 2000)

    return () => {
      cancelled = true
      clearTimeout(timer)
      if (stopPollingRef.current) {
        stopPollingRef.current()
        stopPollingRef.current = null
      }
    }
  }, [connectBackend, startPolling, connectionStatus, setConnection])

  const handleReconnect = () => {
    if (stopPollingRef.current) {
      stopPollingRef.current()
      stopPollingRef.current = null
    }
    void connectBackend()
  }

  return (
    <>
      {children}
      {connectionStatus !== "connected" && !mockEnabled && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          <div className="bg-red-900/50 border border-red-500/50 text-red-200 text-xs p-2 rounded max-w-xs">
            <div className="font-bold mb-1">Backend Not Connected</div>
            <div className="mb-1">{connectionDetail ?? "checking…"}</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReconnect}
            disabled={connectionStatus === "connecting"}
          >
            {connectionStatus === "connecting" ? (
              <RefreshCw size={14} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            {connectionStatus === "connecting"
              ? "Connecting…"
              : connectionDetail
                ? `Reconnect (${connectionDetail})`
                : "Reconnect to backend"}
          </Button>
        </div>
      )}
    </>
  )
}
