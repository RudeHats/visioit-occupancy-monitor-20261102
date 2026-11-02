import { Badge } from "@/components/ui/badge"

export function SimulationBadge() {
  return (
    <Badge className="simulation-badge" variant="outline" aria-label="Simulated preview data">
      <span className="status-dot is-warn" aria-hidden="true" />
      SIMULATED
    </Badge>
  )
}
