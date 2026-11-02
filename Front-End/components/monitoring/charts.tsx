"use client"

import { useId } from "react"
import { Activity } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { EmptyState } from "@/components/monitoring/empty-state"
import { demoOccupancyTrend, demoSeats } from "@/lib/mock/preview-data"

export function Sparkline({
  data,
  color,
  label,
}: {
  data: number[]
  color: string
  label: string
}) {
  const id = useId().replaceAll(":", "")
  const points = data.map((value, index) => ({ index, value }))

  return (
    <div className="sparkline" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 3, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            fill={`url(#spark-${id})`}
            strokeWidth={1.7}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function OccupancyTrendChart() {
  return (
    <div className="occupancy-chart" role="img" aria-label="Simulated occupied and vacant seat counts over the local sample window">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={demoOccupancyTrend} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="occupied-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ok)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--ok)" stopOpacity={0.01} />
            </linearGradient>
            <linearGradient id="vacant-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--text-muted)", fontSize: 10 }} dy={8} />
          <YAxis domain={[0, 12]} allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
          <Tooltip
            contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}
            labelStyle={{ color: "var(--text-muted)", fontSize: 11 }}
            itemStyle={{ color: "var(--text)", fontSize: 12 }}
            cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
          />
          <Area type="monotone" dataKey="occupied" name="Occupied" stroke="var(--ok)" fill="url(#occupied-fill)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Area type="monotone" dataKey="vacant" name="Vacant" stroke="var(--accent)" fill="url(#vacant-fill)" strokeWidth={1.8} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function ConfidenceChart({ histogram }: { histogram?: { bins: number[]; counts: number[] } }) {
  const values = demoSeats.flatMap((seat) => (seat.confidence === null ? [] : [seat.confidence]))
  const ranges = [
    { label: "0.50–0.60", minimum: 0.5, maximum: 0.6 },
    { label: "0.60–0.70", minimum: 0.6, maximum: 0.7 },
    { label: "0.70–0.80", minimum: 0.7, maximum: 0.8 },
    { label: "0.80–0.90", minimum: 0.8, maximum: 0.9 },
    { label: "0.90–1.00", minimum: 0.9, maximum: 1.01 },
  ]
  const data = ranges.map((range) => ({
    label: range.label,
    detections: histogram
      ? histogram.counts.slice(Math.ceil(range.minimum * 10), Math.ceil(range.maximum * 10)).reduce((sum, count) => sum + count, 0)
      : values.filter((value) => value >= range.minimum && value < range.maximum).length,
  }))

  return (
    <div className="confidence-chart" role="img" aria-label="Confidence distribution for detections">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--text-muted)", fontSize: 10 }} dy={8} />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: "var(--text-muted)", fontSize: 10 }} />
          <Tooltip
            contentStyle={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)" }}
            labelStyle={{ color: "var(--text-muted)", fontSize: 11 }}
            itemStyle={{ color: "var(--text)", fontSize: 12 }}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          <Bar dataKey="detections" name="Detections" fill="var(--accent)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function LatencyChart({ values }: { values?: { p50?: number | null; p95?: number | null; p99?: number | null } }) {
  const data = ["p50", "p95", "p99"].map((label) => ({ label, ms: values?.[label as "p50" | "p95" | "p99"] ?? 0 }))
  return (
    <TelemetryBar data={data} valueKey="ms" name="Latency (ms)" />
  )
}

export function FpsChart({ captureFps, processingFps }: { captureFps?: number | null; processingFps?: number | null }) {
  const data = [{ label: "Capture", fps: captureFps ?? 0 }, { label: "Inference", fps: processingFps ?? 0 }]
  return (
    <TelemetryBar data={data} valueKey="fps" name="FPS" />
  )
}

function TelemetryBar({ data, valueKey, name }: { data: { label: string; [key: string]: number | string }[]; valueKey: string; name: string }) {
  return <div className="telemetry-chart-placeholder" role="img" aria-label={name}>
    <ResponsiveContainer width="100%" height="100%"><BarChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" /><XAxis dataKey="label" axisLine={false} tickLine={false} /><YAxis axisLine={false} tickLine={false} /><Tooltip /><Bar dataKey={valueKey} name={name} fill="var(--accent)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
    </BarChart></ResponsiveContainer>
  </div>
}

function TelemetryChartPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="telemetry-chart-placeholder">
      <div className="telemetry-chart-grid" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <EmptyState icon={Activity} title={title} description={description} />
    </div>
  )
}
