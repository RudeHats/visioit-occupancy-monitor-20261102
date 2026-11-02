"use client"

import { useEffect, useRef, useState } from "react"
import { Activity, Radio, TriangleAlert, Video, Volume2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { AlertBanner } from "@/components/monitoring/alert-banner"
import { EmptyState } from "@/components/monitoring/empty-state"
import { ConnectionNotice, MetricTile, PageHeader, Panel } from "@/components/monitoring/ui"
import { OccupancyTimeline } from "@/components/monitoring/occupancy-timeline"
import { SeatCard } from "@/components/monitoring/seat-card"
import { StatusBadge } from "@/components/monitoring/status-badge"
import { VideoPanel } from "@/components/monitoring/video-panel"
import { canPlayAlert } from "@/lib/monitoring/alerts"
import { playAlertTone } from "@/lib/monitoring/alert-audio"
import { api, streamUrl } from "@/lib/monitoring/api"
import { mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import type { NormalizedPoint } from "@/lib/monitoring/domain"

export default function LiveMonitoringPage() {
  const seats = useMonitoringStore((state) => state.seats)
  const events = useMonitoringStore((state) => state.events)
  const region = useMonitoringStore((state) => state.region)
  const settings = useMonitoringStore((state) => state.settings)
  const saveRegion = useMonitoringStore((state) => state.saveRegion)
  const acknowledgeEvent = useMonitoringStore((state) => state.acknowledgeEvent)
  const snoozeEvent = useMonitoringStore((state) => state.snoozeEvent)
  const runDemoAlert = useMonitoringStore((state) => state.runDemoAlert)
  const connectionStatus = useMonitoringStore((state) => state.connection.status)

  const lastSoundAt = useRef<number | undefined>(undefined)
  const [selectedSeatId, setSelectedSeatId] = useState("A-07")
  const [editingRegion, setEditingRegion] = useState(false)
  const [regionSaved, setRegionSaved] = useState(false)
  const isLiveBackend = !mockEnabled && (connectionStatus === "connected" || connectionStatus === "reconnecting")

  const effectiveSeatId = seats.some((seat) => seat.id === selectedSeatId)
    ? selectedSeatId
    : (seats[0]?.id ?? selectedSeatId)
  const selectedSeat = seats.find((seat) => seat.id === effectiveSeatId) ?? seats[0]

  const activeAlert = events.find(
    (event) =>
      event.type === "vacancy_confirmed" &&
      (event.severity === "warning" || event.severity === "critical") &&
      !event.acknowledged &&
      !event.snoozedUntil,
  )

  const handleSaveRegion = (points: NormalizedPoint[]) => {
    saveRegion(points)
    setEditingRegion(false)
    setRegionSaved(true)
    if (isLiveBackend && selectedSeat) {
      void api
        .seatUpdate(selectedSeat.id, {
          seat_id: selectedSeat.id,
          name: selectedSeat.name,
          polygon: points,
          camera_id: selectedSeat.cameraId,
          enabled: true,
        })
        .catch(() => undefined)
    }
  }

  const handleRunAlert = async () => {
    const event = await runDemoAlert()
    if (!event) return

    const state = useMonitoringStore.getState()
    const current = Date.now()
    if (
      state.settings.soundEnabled &&
      state.soundUnlocked &&
      !state.muted &&
      canPlayAlert(event, {
        now: current,
        cooldownSeconds: state.settings.alertCooldownSeconds,
        lastPlayedAt: lastSoundAt.current,
      }) &&
      playAlertTone(state.settings.soundVolume / 100)
    ) {
      lastSoundAt.current = current
    }
  }

  if (mockEnabled) {
    return <PreviewLivePage />
  }

  if (connectionStatus === "offline") {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="OPERATIONAL VIEW"
          title="Live monitoring"
          description="Real-time video, occupancy tracking, and detection region setup."
        />
        <ConnectionNotice />
      </div>
    )
  }

  const vacancySecondsLeft = selectedSeat?.state === "vacant" && selectedSeat.vacantForSeconds !== undefined
    ? Math.max(0, settings.vacancyDurationSeconds - selectedSeat.vacantForSeconds)
    : null
  const vacancyTimer = selectedSeat?.state === "vacant" && vacancySecondsLeft !== null
    ? formatCountdown(vacancySecondsLeft)
    : "—"

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="OPERATIONAL VIEW"
        title="Live monitoring"
        description="Real-time video, occupancy tracking, and detection region setup."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void handleRunAlert()}>
              <TriangleAlert data-icon="inline-start" aria-hidden="true" />Simulate vacancy alert
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setEditingRegion(true); setRegionSaved(false) }} disabled={editingRegion}>
              <Video data-icon="inline-start" aria-hidden="true" />
              {editingRegion ? "Editor open" : "Edit regions"}
            </Button>
          </>
        }
      />

      {activeAlert && (
        <AlertBanner
          event={activeAlert}
          onAcknowledge={acknowledgeEvent}
          onSnooze={snoozeEvent}
        />
      )}

      {regionSaved && (
        <div className="inline-success" role="status">
          <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
          Region saved to the backend camera session.
        </div>
      )}

      <div className="live-grid">
        <VideoPanel
          region={selectedSeat?.polygon ?? region}
          state={selectedSeat?.state ?? "uncertain"}
          editing={editingRegion}
          onSave={handleSaveRegion}
          onCancel={() => setEditingRegion(false)}
          frameSrc={selectedSeat ? streamUrl(selectedSeat.cameraId) : undefined}
          frameLive
          cameraId={selectedSeat?.cameraId}
        />

        <div className="inspector-stack">
          <Panel title="Seat inspector" subtitle="Per-seat state and observation details" simulated={false}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="inspector-seat">Seat</FieldLabel>
                <Select value={effectiveSeatId} onValueChange={(value) => {
                  if (typeof value === "string") setSelectedSeatId(value)
                }}>
                  <SelectTrigger id="inspector-seat" className="w-full">
                    <SelectValue placeholder="Choose a seat" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {seats.map((seat) => (
                        <SelectItem key={seat.id} value={seat.id}>{seat.id} · {seat.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            {selectedSeat ? (
              <div className="inspector-details">
                <div className="inspector-state-row">
                  <span className="inspector-seat-name">{selectedSeat.name}</span>
                  <StatusBadge state={selectedSeat.state} />
                </div>
                <div className="inspector-metrics">
                  <MetricTile label="State duration" value={selectedSeat.state === "vacant" ? formatDurationLabel(selectedSeat.vacantForSeconds ?? 0) : "—"} detail="Time in current state" />
                  <MetricTile
                    label="Confidence"
                    value={selectedSeat.confidence === null ? "—" : `${Math.round(selectedSeat.confidence * 100)}%`}
                    detail={selectedSeat.confidence === null ? "Not reported" : "Backend confidence"}
                  />
                  <MetricTile label="Inference latency" value={formatLatencyMs(useMonitoringStore.getState().metrics?.inference_ms?.last)} detail="Backend reported" />
                  <MetricTile label="FPS" value={useMonitoringStore.getState().metrics?.processing_fps?.toFixed(1) ?? "—"} detail="Backend reported" />
                  <MetricTile label="Vacancy timer" value={vacancyTimer} detail={selectedSeat.state !== "vacant" ? "Only runs for a vacant seat" : "Time until the vacancy alert threshold"} />
                  <MetricTile label="Camera" value={selectedSeat.cameraId} detail="Backend source" />
                </div>
                {selectedSeat.state === "camera_unavailable" && (
                  <p className="state-caution" role="status">No valid frames. This is NOT vacancy.</p>
                )}
                {selectedSeat.state === "uncertain" && (
                  <p className="state-caution" role="status">Low confidence. No vacancy alert is raised for an uncertain state.</p>
                )}
                {selectedSeat.state === "model_error" && (
                  <p className="state-caution" role="status">Inference failed. No vacancy is inferred.</p>
                )}
              </div>
            ) : (
              <EmptyState
                icon={Radio}
                title="Seat not available"
                description="Choose another seat or connect the backend before loading live state."
              />
            )}
          </Panel>

          <OccupancyTimeline seatId={effectiveSeatId} />

          <Panel title="Alert sound" subtitle="Browser audio is opt-in" simulated={false}>
            <div className="audio-info-row">
              <Volume2 size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>Enable sound from the top bar or Settings before testing alert audio.</span>
            </div>
          </Panel>
        </div>
      </div>

      <section className="seat-section" aria-labelledby="live-seats-title">
        <div className="section-heading-row">
          <h2 className="section-heading" id="live-seats-title">Monitored seats</h2>
          <span className="section-caption">{seats.length} backend seats · LIVE</span>
        </div>
        <div className="seat-grid">
          {seats.map((seat) => <SeatCard key={seat.id} seat={seat} />)}
        </div>
      </section>
    </div>
  )
}

function formatLatencyMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${value.toFixed(1)} ms`
}

function formatDurationLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${String(minutes).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

function PreviewLivePage() {
  const seats = useMonitoringStore((state) => state.seats)
  const events = useMonitoringStore((state) => state.events)
  const region = useMonitoringStore((state) => state.region)
  const settings = useMonitoringStore((state) => state.settings)
  const saveRegion = useMonitoringStore((state) => state.saveRegion)
  const acknowledgeEvent = useMonitoringStore((state) => state.acknowledgeEvent)
  const snoozeEvent = useMonitoringStore((state) => state.snoozeEvent)
  const triggerDemoAlert = useMonitoringStore((state) => state.triggerDemoAlert)
  const lastSoundAt = useRef<number | undefined>(undefined)
  const simulationStartedAtRef = useRef<number | null>(null)
  const [selectedSeatId, setSelectedSeatId] = useState("A-07")
  const [editingRegion, setEditingRegion] = useState(false)
  const [regionSaved, setRegionSaved] = useState(false)
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null)
  const selectedSeat = seats.find((seat) => seat.id === selectedSeatId)
  const activeAlert = events.find(
    (event) =>
      event.type === "vacancy_confirmed" &&
      event.severity !== "info" &&
      !event.acknowledged &&
      !event.snoozedUntil,
  )

  useEffect(() => {
    if (simulationStartedAtRef.current === null) {
      simulationStartedAtRef.current = Date.now()
    }
    const initialTick = window.setTimeout(() => {
      if (simulationStartedAtRef.current !== null) {
        setElapsedSeconds(0)
      }
    }, 0)
    const interval = window.setInterval(() => {
      if (simulationStartedAtRef.current !== null) {
        setElapsedSeconds(Math.floor((Date.now() - simulationStartedAtRef.current) / 1000))
      }
    }, 1000)
    return () => {
      window.clearTimeout(initialTick)
      window.clearInterval(interval)
    }
  }, [])

  const handleSaveRegion = (points: NormalizedPoint[]) => {
    saveRegion(points)
    setEditingRegion(false)
    setRegionSaved(true)
  }

  const handleRunAlert = () => {
    const event = triggerDemoAlert()
    if (!event) return

    const state = useMonitoringStore.getState()
    const current = Date.now()
    if (
      state.settings.soundEnabled &&
      state.soundUnlocked &&
      !state.muted &&
      canPlayAlert(event, {
        now: current,
        cooldownSeconds: state.settings.alertCooldownSeconds,
        lastPlayedAt: lastSoundAt.current,
      }) &&
      playAlertTone(state.settings.soundVolume / 100)
    ) {
      lastSoundAt.current = current
    }
  }

  const remainingSeconds = elapsedSeconds === null ? null : settings.vacancyDurationSeconds - elapsedSeconds
  const vacancyTimer = selectedSeat?.state !== "vacant" ? "—" : remainingSeconds === null ? "—" : formatCountdown(Math.max(0, remainingSeconds))
  const vacancyTimerDetail = selectedSeat?.state !== "vacant" ? "Only runs for a vacant seat" : remainingSeconds === null ? "Waiting for the local preview clock" : remainingSeconds <= 0 ? "Sample threshold passed" : "Remaining to sample threshold"

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="OPERATIONAL VIEW"
        title="Live monitoring"
        description="A local sample frame, seat-state inspector, and normalized region editor."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={handleRunAlert}>
              <TriangleAlert data-icon="inline-start" aria-hidden="true" />Simulate vacancy alert
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setEditingRegion(true); setRegionSaved(false) }} disabled={editingRegion}>
              <Video data-icon="inline-start" aria-hidden="true" />
              {editingRegion ? "Editor open" : "Edit regions"}
            </Button>
          </>
        }
      />

      {activeAlert && (
        <AlertBanner event={activeAlert} onAcknowledge={acknowledgeEvent} onSnooze={snoozeEvent} />
      )}

      {regionSaved && (
        <div className="inline-success" role="status">
          <Activity size={14} strokeWidth={1.75} aria-hidden="true" />
          Region saved to this preview session only. No backend ROI endpoint was called.
        </div>
      )}

      <div className="live-grid">
        <VideoPanel
          region={region}
          state={selectedSeat?.state ?? "uncertain"}
          editing={editingRegion}
          onSave={handleSaveRegion}
          onCancel={() => setEditingRegion(false)}
        />

        <div className="inspector-stack">
          <Panel title="Seat inspector" subtitle="Per-seat state and observation details" simulated>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="inspector-seat">Seat</FieldLabel>
                <Select value={selectedSeatId} onValueChange={(value) => { if (typeof value === "string") setSelectedSeatId(value) }}>
                  <SelectTrigger id="inspector-seat" className="w-full">
                    <SelectValue placeholder="Choose a seat" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {seats.map((seat) => (
                        <SelectItem key={seat.id} value={seat.id}>{seat.id} · {seat.name.split("·")[1]?.trim()}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            {selectedSeat ? (
              <div className="inspector-details">
                <div className="inspector-state-row">
                  <span className="inspector-seat-name">{selectedSeat.name}</span>
                  <StatusBadge state={selectedSeat.state} />
                </div>
                <div className="inspector-metrics">
                  <MetricTile label="State duration" value={selectedSeat.durationLabel} detail="Sample observation" />
                  <MetricTile label="Confidence" value={selectedSeat.confidence === null ? "—" : `${Math.round(selectedSeat.confidence * 100)}%`} detail={selectedSeat.confidence === null ? "Not reported" : "Sample detection"} />
                  <MetricTile label="Inference latency" value="—" detail="No backend timestamps" />
                  <MetricTile label="FPS" value="—" detail="Not reported" />
                  <MetricTile label="Vacancy timer" value={vacancyTimer} detail={vacancyTimerDetail} />
                  <MetricTile label="Camera" value={selectedSeat.cameraId} detail="Local fixture label" />
                </div>
                {selectedSeat.state === "camera_unavailable" && <p className="state-caution" role="status">No valid frames. This is NOT vacancy.</p>}
                {selectedSeat.state === "uncertain" && <p className="state-caution" role="status">Low confidence. No vacancy alert is raised for an uncertain state.</p>}
                {selectedSeat.state === "model_error" && <p className="state-caution" role="status">Inference failed. No vacancy is inferred.</p>}
              </div>
            ) : (
              <EmptyState icon={Radio} title="Seat not available" description="Choose another seat or connect the backend before loading live state." />
            )}
          </Panel>

          <OccupancyTimeline seatId={selectedSeatId} />

          <Panel title="Alert sound" subtitle="Browser audio is opt-in" simulated>
            <div className="audio-info-row">
              <Volume2 size={15} strokeWidth={1.75} aria-hidden="true" />
              <span>Enable sound from the top bar or Settings before testing alert audio.</span>
            </div>
          </Panel>
        </div>
      </div>

      <section className="seat-section" aria-labelledby="live-seats-title">
        <div className="section-heading-row">
          <h2 className="section-heading" id="live-seats-title">Monitored seats</h2>
          <span className="section-caption">{seats.length} sample seats · SIMULATED</span>
        </div>
        <div className="seat-grid">
          {seats.map((seat) => <SeatCard key={seat.id} seat={seat} />)}
        </div>
      </section>
    </div>
  )
}
