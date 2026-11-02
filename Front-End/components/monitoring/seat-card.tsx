import Image from "next/image"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { Seat } from "@/lib/monitoring/domain"
import { StatusBadge } from "@/components/monitoring/status-badge"

export function SeatCard({ seat }: { seat: Seat }) {
  return (
    <Card className="seat-card">
      <CardHeader className="seat-card-header">
        <CardTitle className="seat-card-title">{seat.id}</CardTitle>
        <span className="nav-link-meta">{seat.cameraId}</span>
      </CardHeader>
      <div className="seat-thumb" aria-hidden="true">
        <Image
          src="/seatline-camera.png"
          alt=""
          fill
          sizes="(max-width: 760px) 50vw, 260px"
          style={{ objectFit: "cover", objectPosition: seat.thumbnailPosition, filter: "saturate(.72) brightness(.78)" }}
        />
        <span className="seat-thumb-label">{seat.durationLabel}</span>
      </div>
      <CardContent className="seat-card-footer">
        <StatusBadge state={seat.state} />
        <span className="seat-confidence">
          {seat.confidence === null ? "—" : `${Math.round(seat.confidence * 100)}%`}
        </span>
      </CardContent>
    </Card>
  )
}
