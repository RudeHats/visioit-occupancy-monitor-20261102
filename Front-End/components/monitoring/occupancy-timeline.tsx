import { Panel } from "@/components/monitoring/ui"
import { demoSeatHistory } from "@/lib/mock/preview-data"
import type { SeatState } from "@/lib/monitoring/domain"

const timeLabels = ["−60 min", "−45 min", "−30 min", "−15 min", "Now"]

export function OccupancyTimeline({ seatId }: { seatId: string }) {
  return (
    <Panel
      title="Seat state · last hour"
      subtitle={`State history for ${seatId}`}
      simulated
    >
      <div className="timeline-wrap">
        <div className="timeline-track" role="img" aria-label={`Simulated state timeline for ${seatId}`}>
          {demoSeatHistory.map((state, index) => (
            <span
              className="timeline-segment"
              data-state={state}
              key={`${state}-${index}`}
              aria-label={stateLabel(state)}
              title={stateLabel(state)}
            />
          ))}
        </div>
        <div className="timeline-labels" aria-hidden="true">
          {timeLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="chart-legend" aria-label="Timeline state legend">
          <LegendItem color="var(--ok)" label="Occupied" />
          <LegendItem color="#5d6570" label="Vacant" />
          <LegendItem color="var(--warn)" label="Uncertain / transitioning" />
          <LegendItem color="#555e68" label="Unavailable" />
        </div>
      </div>
    </Panel>
  )
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="chart-legend-item">
      <span className="chart-legend-swatch" style={{ color }} aria-hidden="true" />
      {label}
    </span>
  )
}

function stateLabel(state: SeatState) {
  return state.replaceAll("_", " ")
}
