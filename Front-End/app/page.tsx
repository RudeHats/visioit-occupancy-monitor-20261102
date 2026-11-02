"use client"

import Link from "next/link"
import { Activity, AlertTriangle, Armchair, CircleHelp, VideoOff } from "lucide-react"
import { ErrorState } from "@/components/monitoring/error-state"
import { PageHeader, Panel, HealthPill } from "@/components/monitoring/ui"
import { KpiCard } from "@/components/monitoring/kpi-card"
import { OccupancyTrendChart, ConfidenceChart } from "@/components/monitoring/charts"
import { EventList } from "@/components/monitoring/event-list"
import { SeatCard } from "@/components/monitoring/seat-card"
import { demoOccupancyTrend } from "@/lib/mock/preview-data"
import { mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import type { MonitorEvent, Seat } from "@/lib/monitoring/domain"

export default function OverviewPage() {
  const seats = useMonitoringStore((state) => state.seats)
  const events = useMonitoringStore((state) => state.events)
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const health = useMonitoringStore((state) => state.health)

  const occupiedCount = seats.filter((seat) => seat.state === "occupied").length
  const vacantCount = seats.filter((seat) => seat.state === "vacant").length
  const uncertainCount = seats.filter((seat) => seat.state === "uncertain").length
  const unavailableCount = seats.filter((seat) => seat.state === "camera_unavailable" || seat.state === "model_error").length
  const transitioningCount = seats.filter((seat) => seat.state === "transitioning").length
  const occupiedSeries = demoOccupancyTrend.map((point) => point.occupied)
  const vacantSeries = demoOccupancyTrend.map((point) => point.vacant)
  const uncertainSeries = [1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 1, uncertainCount]
  const unavailableSeries = [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, unavailableCount]
  const alertCount = events.filter((event) => !event.acknowledged && (event.severity === "warning" || event.severity === "critical")).length

  const isLiveBackend = !mockEnabled && (connectionStatus === "connected" || connectionStatus === "reconnecting")

  if (!mockEnabled && !isLiveBackend) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="MONITORING DASHBOARD"
          title="Overview"
          description="A clear view of seat occupancy, operational status, and event activity."
        />
        <ErrorState />
      </div>
    )
  }

  if (mockEnabled) {
    return (
      <MockOverview
        occupiedCount={occupiedCount}
        vacantCount={vacantCount}
        uncertainCount={uncertainCount}
        unavailableCount={unavailableCount}
        transitioningCount={transitioningCount}
        occupiedSeries={occupiedSeries}
        vacantSeries={vacantSeries}
        uncertainSeries={uncertainSeries}
        unavailableSeries={unavailableSeries}
        alertCount={alertCount}
        seats={seats}
        events={events.slice(0, 5)}
      />
    )
  }

  return (
    <LiveOverview
      occupiedCount={occupiedCount}
      vacantCount={vacantCount}
      uncertainCount={uncertainCount}
      unavailableCount={unavailableCount}
      alertCount={alertCount}
      seats={seats}
      events={events.slice(0, 5)}
      health={health}
    />
  )
}

function MockOverview({
  occupiedCount,
  vacantCount,
  uncertainCount,
  unavailableCount,
  transitioningCount,
  occupiedSeries,
  vacantSeries,
  uncertainSeries,
  unavailableSeries,
  alertCount,
  seats,
  events,
}: {
  occupiedCount: number
  vacantCount: number
  uncertainCount: number
  unavailableCount: number
  transitioningCount: number
  occupiedSeries: number[]
  vacantSeries: number[]
  uncertainSeries: number[]
  unavailableSeries: number[]
  alertCount: number
  seats: Seat[]
  events: MonitorEvent[]
}) {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="MONITORING DASHBOARD"
        title="Overview"
        description="Sample seat detections and operational signals from the local preview."
        actions={
          <Link className="primary-link-button" href="/live">
            <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
            Open live monitor
          </Link>
        }
      />

      <div className="kpi-grid">
        <KpiCard label="Occupied" value={String(occupiedCount)} context="Sample detections" icon={Activity} color="var(--ok)" series={occupiedSeries} simulated />
        <KpiCard label="Vacant" value={String(vacantCount)} context="Sample detections" icon={Armchair} color="var(--neutral-state)" series={vacantSeries} simulated />
        <KpiCard label="Uncertain" value={String(uncertainCount)} context={transitioningCount ? `${transitioningCount} also transitioning` : "Sample detections"} icon={CircleHelp} color="var(--warn)" series={uncertainSeries} simulated />
        <KpiCard label="Unavailable" value={String(unavailableCount)} context="Camera or model unavailable" icon={VideoOff} color="var(--warn)" series={unavailableSeries} simulated />
      </div>

      <div className="overview-primary-grid">
        <Panel title="Occupancy trend" subtitle="Sample seat-state history · last 60 minutes" simulated>
          <OccupancyTrendChart />
          <div className="chart-legend">
            <span className="chart-legend-item">
              <span className="chart-legend-swatch is-occupied" aria-hidden="true" />
              Occupied
            </span>
            <span className="chart-legend-item">
              <span className="chart-legend-swatch is-vacant" aria-hidden="true" />
              Vacant
            </span>
          </div>
        </Panel>

        <Panel title="Operational signals" subtitle="No production backend is connected" simulated>
          <div className="signal-list">
            <HealthPill label="Camera source" value="Generated still" tone="neutral" />
            <HealthPill label="Model metadata" value="Not reported" tone="neutral" />
            <HealthPill label="Inference telemetry" value="Not reported" tone="neutral" />
            <HealthPill label="Backend API" value="Not connected" tone="warn" />
          </div>
          <p className="panel-footnote">
            The local preview does not attempt network, stream, or model calls.
          </p>
        </Panel>
      </div>

      <div className="overview-secondary-grid">
        <Panel title="Current seat states" subtitle={`${seats.length} sample seats · all values simulated`} simulated>
          <div className="seat-grid">
            {seats.map((seat) => <SeatCard key={seat.id} seat={seat} />)}
          </div>
        </Panel>
        <div className="overview-side-stack">
          <Panel title="Recent events" subtitle={`${alertCount} unacknowledged alerts`} simulated>
            <EventList events={events.slice(0, 5)} />
          </Panel>
          <Panel title="Detection confidence" subtitle="Distribution of sample seat detections" simulated contentClassName="no-padding">
            <ConfidenceChart />
          </Panel>
          <Panel title="Important state handling" simulated>
            <div className="signal-note">
              <div className="signal-note-icon"><AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" /></div>
              <p>
                A camera or model error is never treated as a vacant seat. Vacancy alerts are separate events.
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function LiveOverview({
  occupiedCount,
  vacantCount,
  uncertainCount,
  unavailableCount,
  alertCount,
  seats,
  events,
  health,
}: {
  occupiedCount: number
  vacantCount: number
  uncertainCount: number
  unavailableCount: number
  alertCount: number
  seats: Seat[]
  events: MonitorEvent[]
  health: import("@/lib/monitoring/contract").BackendHealth | null
}) {
  const cameraState = health?.camera.state ?? "unknown"
  const modelState = health?.model.state ?? "unknown"

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="MONITORING DASHBOARD"
        title="Overview"
        description="Live occupancy, camera health, and event activity reported by the backend."
        actions={
          <Link className="primary-link-button" href="/live">
            <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
            Open live monitor
          </Link>
        }
      />

      <div className="kpi-grid">
        <KpiCard label="Occupied" value={String(occupiedCount)} context="Backend seat detections" icon={Activity} color="var(--ok)" simulated={false} />
        <KpiCard label="Vacant" value={String(vacantCount)} context="Backend seat detections" icon={Armchair} color="var(--neutral-state)" simulated={false} />
        <KpiCard label="Uncertain" value={String(uncertainCount)} context="Backend seat detections" icon={CircleHelp} color="var(--warn)" simulated={false} />
        <KpiCard label="Unavailable" value={String(unavailableCount)} context="Camera or model unavailable" icon={VideoOff} color="var(--warn)" simulated={false} />
      </div>

      <div className="overview-primary-grid">
        <Panel title="Current seat states" subtitle={`${seats.length} backend seats`}>
          <div className="seat-grid">
            {seats.map((seat) => <SeatCard key={seat.id} seat={seat} />)}
          </div>
        </Panel>

        <div className="overview-side-stack">
          <Panel title="Recent events" subtitle={`${alertCount} unacknowledged alerts`}>
            <EventList events={events.slice(0, 5)} />
          </Panel>
          <Panel title="System health" subtitle="Reported by the backend">
            <div className="signal-list">
              <HealthPill label="Camera source" value={cameraState} tone={cameraState === "connected" ? "ok" : "warn"} />
              <HealthPill label="Model" value={modelState} tone={modelState === "ready" ? "ok" : "warn"} />
              <HealthPill label="Backend API" value="Connected" tone="ok" />
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
