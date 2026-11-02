import type { LucideIcon } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"
import { Sparkline } from "@/components/monitoring/charts"

export function KpiCard({
  label,
  value,
  context,
  icon: Icon,
  color,
  series,
  simulated,
}: {
  label: string
  value: string
  context: string
  icon: LucideIcon
  color: string
  series?: number[]
  simulated: boolean
}) {
  return (
    <Card className="panel kpi-card">
      <CardHeader className="panel-header">
        <div className="panel-heading-row">
          <span className="kpi-label">{label}</span>
          <span className="kpi-icon" style={{ color }} aria-hidden="true">
            <Icon size={15} strokeWidth={1.75} />
          </span>
        </div>
      </CardHeader>
      <CardContent className="panel-content">
        <div className="kpi-value-row">
          <strong className="kpi-value">{value}</strong>
          {simulated && <SimulationBadge />}
        </div>
        <div className="kpi-context">{context}</div>
        {series && <Sparkline data={series} color={color} label={`${label} sample trend`} />}
      </CardContent>
    </Card>
  )
}
