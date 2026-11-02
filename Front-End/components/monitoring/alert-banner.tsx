import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { TriangleAlert } from "lucide-react"
import type { MonitorEvent } from "@/lib/monitoring/domain"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"

export function AlertBanner({
  event,
  onAcknowledge,
  onSnooze,
}: {
  event: MonitorEvent | undefined
  onAcknowledge: (id: string) => void
  onSnooze: (id: string) => void
}) {
  if (!event) return null

  return (
    <Alert className="alert-banner" role="alert">
      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      <div className="alert-banner-content">
        <div className="alert-banner-copy">
          <div className="alert-title-row">
            <AlertTitle>Vacancy confirmed · {event.seatId}</AlertTitle>
            <SimulationBadge />
          </div>
          <AlertDescription>
            {event.seatName} has remained vacant for {formatDuration(event.vacantForSeconds ?? 0)}.
            This alert is part of the local simulation.
          </AlertDescription>
        </div>
        <div className="alert-actions">
          <Button size="sm" variant="outline" type="button" onClick={() => onSnooze(event.id)}>
            Snooze 5 min
          </Button>
          <Button size="sm" type="button" onClick={() => onAcknowledge(event.id)}>
            Acknowledge
          </Button>
        </div>
      </div>
    </Alert>
  )
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`
}
