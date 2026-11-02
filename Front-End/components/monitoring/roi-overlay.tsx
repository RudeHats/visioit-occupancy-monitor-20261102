"use client"

import type { PointerEventHandler, Ref } from "react"
import type { NormalizedPoint, SeatState } from "@/lib/monitoring/domain"
import { normalizedToClient, rectangleToPolygon, type Rect } from "@/lib/roi-geometry"

type RoiTool = "select" | "rectangle" | "polygon"

export function RoiOverlay({
  svgRef,
  containerRect,
  localFrameRect,
  points,
  state,
  editing,
  validDraft,
  selectedIndex,
  tool,
  drawStart,
  previewPoint,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  svgRef: Ref<SVGSVGElement>
  containerRect: Rect | null
  localFrameRect: Rect | null
  points: NormalizedPoint[]
  state: SeatState
  editing: boolean
  validDraft: boolean
  selectedIndex: number | null
  tool: RoiTool
  drawStart: NormalizedPoint | null
  previewPoint: NormalizedPoint | null
  onPointerDown: PointerEventHandler<SVGSVGElement>
  onPointerMove: PointerEventHandler<SVGSVGElement>
  onPointerUp: PointerEventHandler<SVGSVGElement>
}) {
  if (!containerRect) return null

  const pointsAttribute = localFrameRect
    ? points
        .map((point) => {
          const client = normalizedToClient(point, localFrameRect)
          return `${client.x},${client.y}`
        })
        .join(" ")
    : ""

  return (
    <svg
      ref={svgRef}
      className={`video-overlay ${editing ? "is-editing" : ""}`}
      viewBox={`0 0 ${containerRect.width} ${containerRect.height}`}
      preserveAspectRatio="none"
      aria-label="Normalized region of interest overlay"
      role={editing ? "group" : "img"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {editing ? (
        <>
          {points.length > 0 && (
            <>
              <polygon points={pointsAttribute} className={`roi-polygon ${validDraft ? "" : "is-invalid"}`} />
              {points.map((point, index) => {
                const client = localFrameRect ? normalizedToClient(point, localFrameRect) : { x: 0, y: 0 }
                return (
                  <circle
                    key={`handle-${index}`}
                    data-handle-index={index}
                    className={`roi-handle ${selectedIndex === index ? "is-selected" : ""}`}
                    cx={client.x}
                    cy={client.y}
                    r="8"
                    tabIndex={0}
                    role="button"
                    aria-label={`Region point ${index + 1}, ${(point[0] * 100).toFixed(1)} percent across, ${(point[1] * 100).toFixed(1)} percent down`}
                  />
                )
              })}
            </>
          )}
          {drawStart && previewPoint && localFrameRect && (
            <polygon
              points={rectangleToPolygon(drawStart, previewPoint)
                .map((point) => {
                  const client = normalizedToClient(point, localFrameRect)
                  return `${client.x},${client.y}`
                })
                .join(" ")}
              className="roi-polygon roi-polygon-preview"
            />
          )}
          {tool === "polygon" && previewPoint && localFrameRect && points.length > 0 && (
            <line
              x1={normalizedToClient(points[points.length - 1], localFrameRect).x}
              y1={normalizedToClient(points[points.length - 1], localFrameRect).y}
              x2={normalizedToClient(previewPoint, localFrameRect).x}
              y2={normalizedToClient(previewPoint, localFrameRect).y}
              className="roi-polygon-preview-line"
            />
          )}
        </>
      ) : (
        points.length > 0 && (
          <polygon points={pointsAttribute} className="roi-polygon roi-polygon-saved" data-state={state} />
        )
      )}
    </svg>
  )
}
