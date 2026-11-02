"use client"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { useMonitoringStore, mockEnabled } from "@/lib/monitoring/store"
export function BackendConnectionProvider({ children }: { children: React.ReactNode }) {
  const status = useMonitoringStore((s) => s.connection.status)
  const detail = useMonitoringStore((s) => s.connection.detail)
  useEffect(() => {
    if (mockEnabled) return
    const store = useMonitoringStore.getState()
    let busy = false
    const connect = async () => {
      if (busy || useMonitoringStore.getState().connection.status === "connected") return
      busy = true
      try { await store.connectBackend() } finally { busy = false }
    }
    void connect()
    const stop = store.startPolling()
    const retry = setInterval(() => void connect(), 10000)
    return () => { clearInterval(retry); stop(); store.disconnectBackend() }
  }, [])
  return <>{children}{!mockEnabled && status !== "connected" && <div className="fixed bottom-4 right-4 z-50 rounded border bg-background p-3" role="status">
    <p>{detail ?? "Connecting to backend…"}</p>
    <Button type="button" variant="outline" disabled={status === "connecting"} onClick={() => void useMonitoringStore.getState().connectBackend()}>Reconnect</Button>
  </div>}</>
}
