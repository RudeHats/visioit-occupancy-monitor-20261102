"use client"

import { Activity, Camera, Cpu, Database, HardDrive, Radio, ShieldCheck } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { ConfidenceChart, FpsChart, LatencyChart } from "@/components/monitoring/charts"
import { ErrorState } from "@/components/monitoring/error-state"
import { PageHeader, Panel, HealthPill, MetricTile } from "@/components/monitoring/ui"
import { mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import { demoSystemLog } from "@/lib/mock/preview-data"
import type { BackendHealth, BackendModel, BackendMetrics } from "@/lib/monitoring/contract"

export default function SystemPage() {
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const health = useMonitoringStore((state) => state.health)
  const modelInfo = useMonitoringStore((state) => state.modelInfo)
  const metrics = useMonitoringStore((state) => state.metrics)

  const isLiveBackend = !mockEnabled && (connectionStatus === "connected" || connectionStatus === "reconnecting")

  if (!mockEnabled && !isLiveBackend) {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="SYSTEM / DIAGNOSTICS" title="Model & system" description="Review model metadata, runtime health, and inference telemetry." />
        <ErrorState />
      </div>
    )
  }

  return (
    <SystemContent
      live={isLiveBackend}
      health={health}
      modelInfo={modelInfo}
      metrics={metrics}
      systemLog={demoSystemLog}
    />
  )
}

function SystemContent({
  live,
  health,
  modelInfo,
  metrics,
  systemLog,
}: {
  live: boolean
  health: BackendHealth | null
  modelInfo: BackendModel | null
  metrics: BackendMetrics | null
  systemLog: typeof demoSystemLog
}) {
  const modelMetadata: { label: string; value: string }[] = [
    { label: "Model name", value: modelInfo?.name ?? "Not reported" },
    { label: "Version", value: modelInfo?.version ?? "Not reported" },
    { label: "Task", value: modelInfo?.task ?? "Not reported" },
    { label: "Runtime device", value: modelInfo?.device ?? "Not reported" },
    { label: "Classes", value: modelInfo?.classes_used.join(", ") || "Not reported" },
    { label: "License", value: modelInfo?.license ?? "Not reported" },
  ]

  const cameraState = health?.camera.state ?? "unknown"
  const modelState = health?.model.state ?? "unknown"

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="SYSTEM / DIAGNOSTICS"
        title="Model & system"
        description={live ? "Runtime and model values reported by the occupancy backend." : "Runtime and model values reported by the local preview."}
        actions={<Badge className="system-mode-badge" variant="outline">{live ? "Backend connected" : "Local preview"}</Badge>}
      />

      <div className="system-summary-grid">
        <Panel title="Model metadata" subtitle={live ? "Reported by the backend at runtime." : "Values are read-only placeholders until the backend contract is available."} simulated={!live}>
          <div className="model-metadata-grid">
            {modelMetadata.map((item) => (
              <MetricTile key={item.label} label={item.label} value={item.value} detail={live ? "Backend reported" : "Not reported in this preview"} />
            ))}
          </div>
        </Panel>

        <Panel title="Runtime health" subtitle={live ? "Reported by the backend over REST and WebSocket." : "Local preview status, not connected hardware or services."} simulated={!live}>
          <div className="runtime-health-list">
            <HealthPill label="Sample camera image" value={live ? "Stream connected" : "Loaded locally"} tone={live ? "ok" : "ok"} />
            <HealthPill label="Camera stream API" value={live ? cameraState : "Not connected"} tone={live && cameraState === "connected" ? "ok" : "neutral"} />
            <HealthPill label="Inference service" value={live ? modelState : "Not connected"} tone={live && modelState === "ready" ? "ok" : "neutral"} />
            <HealthPill label="Event transport" value={live ? "Live WebSocket" : "Local fixture"} tone={live ? "ok" : "ok"} />
          </div>
        </Panel>
      </div>

      <div className="system-telemetry-grid">
        <Panel title="Inference latency" subtitle="p50 · p95 · p99" simulated={!live}>
          <div className="telemetry-stat-row">
            <MetricTile label="p50" value={formatMs(metrics?.inference_ms?.p50)} detail="Backend reported" />
            <MetricTile label="p95" value={formatMs(metrics?.inference_ms?.p95)} detail="Backend reported" />
            <MetricTile label="p99" value={formatMs(metrics?.inference_ms?.p99)} detail="Backend reported" />
          </div>
          <LatencyChart />
        </Panel>

        <Panel title="Frame health" subtitle="FPS and dropped frames" simulated={!live}>
          <div className="telemetry-stat-row">
            <MetricTile label="Frame rate" value={formatNullableNumber(metrics?.processing_fps)} detail="Backend reported" />
            <MetricTile label="Dropped frames" value={String(metrics?.dropped_frames ?? 0)} detail="Backend reported" />
          </div>
          <FpsChart />
        </Panel>

        <Panel title="Sample detection confidence" subtitle="Distribution of backend seat detections · not accuracy." simulated={!live}>
          <ConfidenceChart />
          <p className="chart-caption">Confidence values come from backend detections. They are not a measure of model accuracy.</p>
        </Panel>
      </div>

      <div className="system-lower-grid">
        <Panel title="Preview activity log" subtitle="Local interface events only · not backend logs." simulated={!live}>
          <ul className="system-log-list">
            {systemLog.map((entry, index) => (
              <li className="system-log-row" key={`${entry.text}-${index}`}>
                <span className={`system-log-marker tone-${entry.tone}`} aria-hidden="true" />
                <span className="system-log-time">{entry.time}</span>
                <span className="system-log-message">{entry.text}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Runtime & privacy" subtitle={live ? "Reported runtime facts from the backend." : "No project API or WebSocket requests are made in this preview."} simulated={!live}>
          <div className="runtime-facts-grid">
            <RuntimeFact icon={Database} label="State storage" value="In-memory only" detail={live ? "Backend keeps occupancy state in memory." : "Refresh resets preview state."} />
            <RuntimeFact icon={Radio} label="Network transport" value={live ? "WebSocket + REST" : "None"} detail={live ? "Real-time channel and REST API are in use." : "No API or socket client is enabled."} />
            <RuntimeFact icon={Camera} label="Image source" value={live ? "Backend stream" : "Local generated still"} detail={live ? "Frames come from the backend MJPEG stream." : "No camera frames are transmitted."} />
            <RuntimeFact icon={HardDrive} label="Browser storage" value="Not used" detail="No localStorage or sessionStorage." />
          </div>
        </Panel>
      </div>

      <Alert className="evaluation-notice">
        <ShieldCheck size={16} strokeWidth={1.75} aria-hidden="true" />
        <div>
          <AlertTitle>Evaluation required before operational use</AlertTitle>
          <AlertDescription>
            Accuracy has not been validated on your footage. Evaluate before relying on alerts for safety-critical use.
          </AlertDescription>
        </div>
        <Badge variant="outline" className="notice-state">Not validated</Badge>
      </Alert>

      <div className="page-footnote">
        <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Model version, deployment device, license, p50/p95/p99 latency, frame rate, and dropped-frame counts require backend telemetry and are intentionally not fabricated.</span>
      </div>
    </div>
  )
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${value.toFixed(1)} ms`
}

function formatNullableNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return value.toFixed(1)
}

function RuntimeFact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Cpu
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="runtime-fact">
      <div className="runtime-fact-heading">
        <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <span className="runtime-fact-detail">{detail}</span>
    </div>
  )
}
