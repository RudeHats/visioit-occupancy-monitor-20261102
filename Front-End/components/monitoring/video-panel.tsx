"use client"

import type { NormalizedPoint, SeatState } from "@/lib/monitoring/domain"
import { Panel } from "@/components/monitoring/ui"
import { RoiEditor } from "@/components/monitoring/roi-editor"

export function VideoPanel({
  region,
  state,
  editing,
  onSave,
  onCancel,
  frameSrc,
  frameLive = false,
  cameraId,
}: {
  region: NormalizedPoint[]
  state: SeatState
  editing: boolean
  onSave: (points: NormalizedPoint[]) => void
  onCancel: () => void
  frameSrc?: string
  frameLive?: boolean
  cameraId?: string
}) {
  return (
    <Panel
      title={cameraId ? `CAM-01 · ${cameraId}` : "CAM-01 · North Terminal"}
      subtitle={frameLive ? "Live camera stream · GET /api/v1/stream/{camera_id}.mjpg" : "Generated still image · live stream pending"}
      simulated={!frameLive}
      contentClassName="live-video-content"
    >
      <RoiEditor
        key={editing ? "editing" : "view"}
        region={region}
        state={state}
        editing={editing}
        onSave={onSave}
        onCancel={onCancel}
        frameSrc={frameSrc}
        frameLive={frameLive}
      />
    </Panel>
  )
}
