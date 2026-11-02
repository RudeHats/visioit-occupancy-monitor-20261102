"use client"

import { useMemo, useState } from "react"
import { BellRing, Check, CircleAlert, History, Search, SlidersHorizontal } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { AlertBanner } from "@/components/monitoring/alert-banner"
import { EmptyState } from "@/components/monitoring/empty-state"
import { ErrorState } from "@/components/monitoring/error-state"
import { PageHeader, Panel } from "@/components/monitoring/ui"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"
import { mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import type { EventSeverity, MonitorEvent } from "@/lib/monitoring/domain"

type EventFilter = "all" | "vacancies" | "transitions" | "system"
type SeverityFilter = "all" | EventSeverity
type TimeFilter = "all" | "hour" | "day"

const eventFilters: { value: EventFilter; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "vacancies", label: "Vacancies" },
  { value: "transitions", label: "State changes" },
  { value: "system", label: "System" },
]

export default function EventsPage() {
  const events = useMonitoringStore((state) => state.events)
  const acknowledgeEvent = useMonitoringStore((state) => state.acknowledgeEvent)
  const snoozeEvent = useMonitoringStore((state) => state.snoozeEvent)
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const [typeFilter, setTypeFilter] = useState<EventFilter>("all")
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all")
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all")
  const [query, setQuery] = useState("")

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return events
      .filter((event) => {
        const matchesType =
          typeFilter === "all" ||
          (typeFilter === "vacancies" && event.type === "vacancy_confirmed") ||
          (typeFilter === "transitions" && event.type === "state_changed") ||
          (typeFilter === "system" && ["camera_unavailable", "model_error"].includes(event.type))
        const matchesSeverity = severityFilter === "all" || event.severity === severityFilter
        const age = event.ageMinutes ?? Number.POSITIVE_INFINITY
        const matchesTime =
          timeFilter === "all" ||
          (timeFilter === "hour" && age <= 60) ||
          (timeFilter === "day" && age <= 1440)
        const searchableText = `${event.seatId} ${event.seatName} ${event.description}`.toLowerCase()
        return matchesType && matchesSeverity && matchesTime && (!normalizedQuery || searchableText.includes(normalizedQuery))
      })
      .sort((a, b) => (a.ageMinutes ?? Number.POSITIVE_INFINITY) - (b.ageMinutes ?? Number.POSITIVE_INFINITY))
  }, [events, query, severityFilter, timeFilter, typeFilter])

  const activeAlert = events.find(
    (event) =>
      event.type === "vacancy_confirmed" &&
      event.severity !== "info" &&
      !event.acknowledged &&
      !event.snoozedUntil,
  )

  if (!mockEnabled && connectionStatus !== "connected" && connectionStatus !== "reconnecting") {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="MONITORING / HISTORY" title="Events" description="Search and review vacancy alerts, state changes, and system events." />
        <ErrorState />
      </div>
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="MONITORING / HISTORY"
        title="Events"
        description="Search and review vacancy alerts, seat transitions, and camera health events."
        actions={<SimulationBadge />}
      />

      {activeAlert && (
        <AlertBanner
          event={activeAlert}
          onAcknowledge={() => acknowledgeEvent(activeAlert.id)}
          onSnooze={() => snoozeEvent(activeAlert.id)}
        />
      )}

      <Alert className="history-notice">
        <History data-icon="inline-start" aria-hidden="true" />
        <div>
          <AlertTitle>Session-only history</AlertTitle>
          <AlertDescription>
            History resets when the backend restarts. This preview keeps events in memory and resets on refresh.
          </AlertDescription>
        </div>
        <SimulationBadge />
      </Alert>

      <Panel
        title="Event history"
        subtitle="Newest events first · filter by event type, severity, seat, or time range."
        simulated
        action={<Badge variant="secondary">{filteredEvents.length} events</Badge>}
        contentClassName="event-panel-content"
      >
        <div className="event-filter-layout">
          <div className="event-filter-types">
            <span className="filter-caption">Event type</span>
            <ToggleGroup
              multiple={false}
              value={[typeFilter]}
              onValueChange={(values) => {
                if (values[0]) setTypeFilter(values[0] as EventFilter)
              }}
              aria-label="Filter events by type"
              className="event-type-toggle"
            >
              {eventFilters.map((filter) => (
                <ToggleGroupItem key={filter.value} value={filter.value} aria-label={filter.label}>
                  {filter.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <FieldGroup className="event-filter-controls">
            <Field>
              <FieldLabel htmlFor="event-search">Seat or event</FieldLabel>
              <div className="search-input-wrap">
                <Search size={14} strokeWidth={1.75} aria-hidden="true" />
                <Input
                  id="event-search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search seats or descriptions"
                  aria-label="Search seats or event descriptions"
                />
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-severity">Severity</FieldLabel>
              <Select value={severityFilter} onValueChange={(value) => setSeverityFilter((value as SeverityFilter) || "all")}>
                <SelectTrigger id="event-severity" aria-label="Filter by severity">
                  <SelectValue placeholder="All severities" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All severities</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-time-range">Time range</FieldLabel>
              <Select value={timeFilter} onValueChange={(value) => setTimeFilter((value as TimeFilter) || "all")}>
                <SelectTrigger id="event-time-range" aria-label="Filter by time range">
                  <SelectValue placeholder="All time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All time</SelectItem>
                    <SelectItem value="hour">Last hour</SelectItem>
                    <SelectItem value="day">Last 24 hours</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
        </div>

        <div className="event-table-wrap">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead aria-sort="ascending">Time</TableHead>
                <TableHead>Seat</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Vacancy duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="table-actions-heading">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvents.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="event-empty-cell">
                    <EmptyState icon={SlidersHorizontal} title="No matching events" description="Adjust the filters or search terms to see other events." />
                  </TableCell>
                </TableRow>
              ) : (
                filteredEvents.map((event) => <EventRow key={event.id} event={event} onAcknowledge={acknowledgeEvent} onSnooze={snoozeEvent} />)
              )}
            </TableBody>
          </Table>
        </div>
      </Panel>

      <div className="page-footnote">
        <CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Local event examples are synthetic and do not represent a connected camera or backend event stream.</span>
      </div>
    </div>
  )
}

function EventRow({
  event,
  onAcknowledge,
  onSnooze,
}: {
  event: MonitorEvent
  onAcknowledge: (id: string) => void
  onSnooze: (id: string) => void
}) {
  return (
    <TableRow>
      <TableCell>
        <span className="event-time">{event.timeLabel}</span>
        <span className="event-time-detail">{event.ageMinutes === 0 ? "Preview event" : "Local preview"}</span>
      </TableCell>
      <TableCell>
        <span className="event-seat-id">{event.seatId}</span>
        <span className="event-seat-name">{event.seatName.replace(`${event.seatId} · `, "")}</span>
      </TableCell>
      <TableCell>
        <div className="event-description-cell">
          <EventTypeBadge event={event} />
          <span>{event.description}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge className={`severity-badge severity-${event.severity}`} variant="outline">
          <span className="severity-dot" aria-hidden="true" />
          {event.severity}
        </Badge>
      </TableCell>
      <TableCell className="mono-cell">{event.vacantForSeconds ? formatDuration(event.vacantForSeconds) : "—"}</TableCell>
      <TableCell>
        <Badge className={`event-status-badge ${event.acknowledged ? "is-acknowledged" : "is-open"}`} variant="outline">
          {event.acknowledged ? "Acknowledged" : "Open"}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="event-row-actions">
          {!event.acknowledged && (
            <>
              <Button size="sm" variant="outline" onClick={() => onAcknowledge(event.id)} aria-label={`Acknowledge ${event.type} for ${event.seatId}`}>
                <Check data-icon="inline-start" aria-hidden="true" />Acknowledge
              </Button>
              <Button size="icon" variant="ghost" onClick={() => onSnooze(event.id)} aria-label={`Snooze alert for ${event.seatId}`} title="Snooze for five minutes">
                <BellRing data-icon="inline-start" aria-hidden="true" />
              </Button>
            </>
          )}
          {event.acknowledged && <span className="muted-text">No action</span>}
        </div>
      </TableCell>
    </TableRow>
  )
}

function EventTypeBadge({ event }: { event: MonitorEvent }) {
  const labels: Record<MonitorEvent["type"], string> = {
    vacancy_confirmed: "Vacancy confirmed",
    state_changed: "State changed",
    seat_occupied: "Seat occupied",
    seat_vacant: "Seat vacant",
    camera_unavailable: "Camera unavailable",
    camera_recovered: "Camera recovered",
    model_error: "Model error",
  }
  return <span className={`event-type-label event-type-${event.type}`}>{labels[event.type]}</span>
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`
}
