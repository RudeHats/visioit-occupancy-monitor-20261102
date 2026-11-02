import type { ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"
import { WifiOff } from "lucide-react"

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-copy">
        <p className="overline">{eyebrow}</p>
        <h1 className="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions && <div className="page-heading-actions">{actions}</div>}
    </header>
  )
}

export function Panel({
  title,
  subtitle,
  children,
  action,
  simulated = false,
  className = "",
  contentClassName = "",
  divider = false,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  action?: ReactNode
  simulated?: boolean
  className?: string
  contentClassName?: string
  divider?: boolean
}) {
  return (
    <Card className={`panel ${className}`}>
      <CardHeader className={`panel-header ${divider ? "has-divider" : ""}`}>
        <div className="panel-heading-row">
          <div>
            <CardTitle className="panel-title">{title}</CardTitle>
            {subtitle && <CardDescription className="panel-subtitle">{subtitle}</CardDescription>}
          </div>
          <div className="panel-actions">
            {simulated && <SimulationBadge />}
            {action}
          </div>
        </div>
      </CardHeader>
      <CardContent className={`panel-content ${contentClassName}`}>{children}</CardContent>
    </Card>
  )
}

export function ConnectionNotice() {
  return (
    <Alert className="connection-alert">
      <WifiOff size={16} strokeWidth={1.75} aria-hidden="true" />
      <div>
        <AlertTitle>Backend is not connected</AlertTitle>
        <AlertDescription>
          API and live-stream wiring are waiting for the required integration contract. Set
          <code> NEXT_PUBLIC_USE_MOCK=true </code> in a development preview to show clearly labeled sample data.
        </AlertDescription>
      </div>
    </Alert>
  )
}

export function MetricTile({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="metric-tile">
      <div className="metric-tile-label">{label}</div>
      <div className="metric-tile-value">{value}</div>
      {detail && <div className="metric-tile-detail">{detail}</div>}
    </div>
  )
}

export function HealthPill({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: "ok" | "warn" | "neutral"
}) {
  return (
    <div className="health-pill" data-tone={tone}>
      <span className="health-pill-leading">
        <span className="status-dot" aria-hidden="true" />
        <span>{label}</span>
      </span>
      <span className="health-pill-state">{value}</span>
    </div>
  )
}
