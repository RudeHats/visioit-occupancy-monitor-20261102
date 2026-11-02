import {
  Activity,
  Armchair,
  Camera,
  Cpu,
  TriangleAlert,
  UserCheck,
  VideoOff,
  type LucideIcon,
} from "lucide-react"
import type { MonitorEvent } from "@/lib/monitoring/domain"

const eventPresentation: Record<MonitorEvent["type"], { label: string; icon: LucideIcon; tone: string }> = {
  vacancy_confirmed: { label: "Vacancy confirmed", icon: TriangleAlert, tone: "warn" },
  state_changed: { label: "State changed", icon: Activity, tone: "neutral" },
  seat_occupied: { label: "Seat occupied", icon: UserCheck, tone: "ok" },
  seat_vacant: { label: "Seat vacant", icon: Armchair, tone: "neutral" },
  camera_unavailable: { label: "Camera unavailable", icon: VideoOff, tone: "warn" },
  camera_recovered: { label: "Camera recovered", icon: Camera, tone: "ok" },
  model_error: { label: "Model error", icon: Cpu, tone: "danger" },
}

export function EventList({
  events,
  limit,
}: {
  events: MonitorEvent[]
  limit?: number
}) {
  const visibleEvents = typeof limit === "number" ? events.slice(0, limit) : events

  if (visibleEvents.length === 0) {
    return <p className="section-caption">No events in this session.</p>
  }

  return (
    <ul className="event-list" aria-label="Recent monitoring events">
      {visibleEvents.map((event) => {
        const presentation = eventPresentation[event.type]
        const Icon = presentation.icon
        return (
          <li className="event-list-item" key={event.id}>
            <span className="event-icon-wrap" data-tone={presentation.tone} aria-hidden="true">
              <Icon size={13} strokeWidth={1.75} />
            </span>
            <div className="event-list-copy">
              <p className="event-list-title">{presentation.label} · {event.seatId}</p>
              <p className="event-list-description">{event.description}</p>
            </div>
            <time className="event-list-time">{event.timeLabel}</time>
          </li>
        )
      })}
    </ul>
  )
}
