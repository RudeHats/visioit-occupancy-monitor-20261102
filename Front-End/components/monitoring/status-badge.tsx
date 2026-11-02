import {
  Armchair,
  CircleHelp,
  LoaderCircle,
  TriangleAlert,
  UserCheck,
  VideoOff,
  type LucideIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { SeatState } from "@/lib/monitoring/domain"

const statePresentation: Record<SeatState, { label: string; description: string; icon: LucideIcon; className: string }> = {
  occupied: {
    label: "Seat in use",
    description: "A person is detected in the seat.",
    icon: UserCheck,
    className: "state-occupied",
  },
  vacant: {
    label: "Seat empty",
    description: "The seat is empty; its vacancy timer is running.",
    icon: Armchair,
    className: "state-vacant",
  },
  uncertain: {
    label: "Uncertain",
    description: "Classification is uncertain; no vacancy alert is raised.",
    icon: CircleHelp,
    className: "state-uncertain",
  },
  transitioning: {
    label: "Transitioning",
    description: "The state is being verified; no vacancy alert is raised.",
    icon: LoaderCircle,
    className: "state-transitioning",
  },
  camera_unavailable: {
    label: "Camera unavailable",
    description: "No valid frames are available; vacancy is not inferred.",
    icon: VideoOff,
    className: "state-camera-unavailable",
  },
  model_error: {
    label: "Model error",
    description: "Inference is unavailable; vacancy is not inferred.",
    icon: TriangleAlert,
    className: "state-model-error",
  },
}

export function getStatePresentation(state: SeatState) {
  return statePresentation[state]
}

export function StatusBadge({ state }: { state: SeatState }) {
  const presentation = statePresentation[state]
  const Icon = presentation.icon

  return (
    <Badge
      className={`state-badge ${presentation.className}`}
      variant="outline"
      aria-label={`Seat status: ${presentation.label}. ${presentation.description}`}
      title={presentation.description}
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
      <span>{presentation.label}</span>
    </Badge>
  )
}
