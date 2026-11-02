"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import Image from "next/image"
import { Check, Crop, MousePointer2, Pentagon, RotateCcw, Square, Trash2, Undo2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { RoiOverlay } from "@/components/monitoring/roi-overlay"
import { SimulationBadge } from "@/components/monitoring/simulation-badge"
import type { NormalizedPoint, SeatState } from "@/lib/monitoring/domain"
import {
  clampPoint,
  clientToNormalized,
  getContainRect,
  getPolygonBounds,
  isValidPolygon,
  rectangleToPolygon,
  type Rect,
} from "@/lib/roi-geometry"

type RoiTool = "select" | "rectangle" | "polygon"

export function RoiEditor({
  region,
  state,
  editing,
  onSave,
  onCancel,
  frameSrc,
  frameLive = false,
}: {
  region: NormalizedPoint[]
  state: SeatState
  editing: boolean
  onSave: (points: NormalizedPoint[]) => void
  onCancel: () => void
  frameSrc?: string
  frameLive?: boolean
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const undoStack = useRef<NormalizedPoint[][]>([])
  const dragIndex = useRef<number | null>(null)
  const [containerRect, setContainerRect] = useState<Rect | null>(null)
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
  const [draft, setDraft] = useState<NormalizedPoint[]>(() => copyRegion(region))
  const [previewPoint, setPreviewPoint] = useState<NormalizedPoint | null>(null)
  const [drawStart, setDrawStart] = useState<NormalizedPoint | null>(null)
  const [tool, setTool] = useState<RoiTool>("select")
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [showCrop, setShowCrop] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [frameLoaded] = useState(false)
  const isLiveFrame = frameLive && Boolean(frameSrc)

  const measureFrame = useCallback(() => {
    const frame = frameRef.current
    const image = imageRef.current
    if (!frame || !image) return

    const bounds = frame.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return

    setContainerRect({
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    })
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
    }
  }, [])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureFrame)
    observer?.observe(frame)
    const animationFrame = window.requestAnimationFrame(measureFrame)
    window.addEventListener("resize", measureFrame)
    window.addEventListener("scroll", measureFrame, true)

    return () => {
      observer?.disconnect()
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener("resize", measureFrame)
      window.removeEventListener("scroll", measureFrame, true)
    }
  }, [measureFrame])

  const fittedRect = useMemo(() => {
    if (!containerRect || imageSize.width <= 0 || imageSize.height <= 0) return null
    return getContainRect(containerRect, imageSize)
  }, [containerRect, imageSize])

  const localFrameRect = useMemo(() => {
    if (!containerRect || !fittedRect) return null
    return {
      left: fittedRect.left - containerRect.left,
      top: fittedRect.top - containerRect.top,
      width: fittedRect.width,
      height: fittedRect.height,
    }
  }, [containerRect, fittedRect])

  const pushUndo = () => {
    undoStack.current.push(copyRegion(draft))
    setUndoCount(undoStack.current.length)
  }

  const getPointerPoint = (event: PointerEvent<SVGSVGElement>, rect: Rect) => {
    const point = clientToNormalized(event.clientX, event.clientY, rect)
    if (point) return point
    return clampPoint([
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    ])
  }

  const handlePointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (!editing || !fittedRect) return

    const target = event.target as SVGElement
    const handle = target.closest("[data-handle-index]")
    if (handle) {
      const index = Number(handle.getAttribute("data-handle-index"))
      if (!Number.isInteger(index)) return
      event.preventDefault()
      dragIndex.current = index
      setSelectedIndex(index)
      pushUndo()
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    const point = getPointerPoint(event, fittedRect)
    if (tool === "rectangle") {
      event.preventDefault()
      pushUndo()
      setDraft([])
      setDrawStart(point)
      setPreviewPoint(point)
      setSelectedIndex(null)
      setShowCrop(false)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    if (tool === "polygon") {
      event.preventDefault()
      if (draft.length >= 3 && distance(point, draft[0]) < 0.025) {
        setTool("select")
        setPreviewPoint(null)
        return
      }
      pushUndo()
      setDraft((current) => [...current, point])
      setSelectedIndex(draft.length)
      setPreviewPoint(point)
      setShowCrop(false)
    }
  }

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!editing || !fittedRect) return
    const point = getPointerPoint(event, fittedRect)

    if (dragIndex.current !== null) {
      const index = dragIndex.current
      setDraft((current) => current.map((existing, currentIndex) => currentIndex === index ? point : existing))
      setShowCrop(false)
      return
    }

    if (drawStart || (tool === "polygon" && draft.length > 0)) setPreviewPoint(point)
  }

  const handlePointerUp = () => {
    if (drawStart && previewPoint) {
      const next = rectangleToPolygon(drawStart, previewPoint)
      if (Math.abs(next[1][0] - next[0][0]) > 0.005 && Math.abs(next[2][1] - next[1][1]) > 0.005) {
        setDraft(next)
        setSelectedIndex(null)
      } else {
        undoStack.current.pop()
        setUndoCount(undoStack.current.length)
      }
      setDrawStart(null)
      setPreviewPoint(null)
      return
    }

    dragIndex.current = null
  }

  const handleUndo = () => {
    const previous = undoStack.current.pop()
    setUndoCount(undoStack.current.length)
    if (!previous) return
    setDraft(previous)
    setSelectedIndex(null)
    setShowCrop(false)
  }

  const handleDelete = () => {
    pushUndo()
    if (selectedIndex !== null) {
      setDraft((current) => current.filter((_, index) => index !== selectedIndex))
      setSelectedIndex(null)
    } else {
      setDraft([])
    }
    setShowCrop(false)
  }

  const handleReset = () => {
    pushUndo()
    setDraft(copyRegion(region))
    setSelectedIndex(null)
    setShowCrop(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing) return
    if (event.target instanceof HTMLElement && event.target.closest("button, input, [role='combobox'], [data-slot='toggle-group-item']")) return
    if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
      return
    }
    if ((event.key === "Delete" || event.key === "Backspace") && selectedIndex !== null) {
      event.preventDefault()
      handleDelete()
      return
    }
    if (selectedIndex === null || !localFrameRect) return

    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    const delta = deltas[event.key]
    if (!delta) return
    event.preventDefault()
    pushUndo()
    const multiplier = event.shiftKey ? 10 : 1
    setDraft((current) => current.map((point, index) => {
      if (index !== selectedIndex) return point
      return clampPoint([
        point[0] + (delta[0] * multiplier) / localFrameRect.width,
        point[1] + (delta[1] * multiplier) / localFrameRect.height,
      ])
    }))
    setShowCrop(false)
  }

  const handleToolChange = (values: string[]) => {
    const value = values[0]
    if (!value) return
    const nextTool = value as RoiTool
    if (nextTool !== tool && (nextTool === "rectangle" || nextTool === "polygon")) {
      pushUndo()
      setDraft([])
      setSelectedIndex(null)
      setShowCrop(false)
    }
    setTool(nextTool)
  }

  const points = editing ? draft : region
  const bounds = getPolygonBounds(points)
  const canTestCrop = Boolean(bounds && bounds.width > 0.01 && bounds.height > 0.01)
  const cropStyle = bounds && canTestCrop
    ? {
        aspectRatio: `${bounds.width} / ${bounds.height}`,
        backgroundImage: "url('/seatline-camera.png')",
        backgroundSize: `${100 / bounds.width}% ${100 / bounds.height}%`,
        backgroundPosition: `${cropPosition(bounds.minX, bounds.width)}% ${cropPosition(bounds.minY, bounds.height)}%`,
      }
    : undefined
  const validDraft = draft.length === 0 || isValidPolygon(draft)

  return (
    <div
      className="roi-editor"
      onKeyDown={handleKeyDown}
      tabIndex={editing ? 0 : undefined}
      aria-label={editing ? "Region editor. Use the draw tool or keyboard arrows to edit points." : undefined}
    >
      <div className="video-frame-wrap" ref={frameRef}>
        {isLiveFrame && frameSrc ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- live MJPEG stream from the backend camera source */}
            <img
              key={frameSrc}
              ref={imageRef}
              className="video-frame-image"
              src={frameSrc}
              alt="Live camera frame from the occupancy backend"
              onLoad={measureFrame}
            />
          </>
        ) : (
          <Image
            ref={imageRef}
            className="video-frame-image"
            src="/seatline-camera.png"
            alt="Generated simulated camera still of a meeting room with one seated occupant"
            fill
            priority
            sizes="(max-width: 760px) 100vw, (max-width: 1180px) 90vw, 70vw"
            onLoad={measureFrame}
          />
        )}
        {isLiveFrame && !frameLoaded && (
          <div className="video-offline">
            <strong>No signal</strong>
            <span>Waiting for the first valid frame from the backend stream.</span>
          </div>
        )}
        <RoiOverlay
          svgRef={svgRef}
          containerRect={containerRect}
          localFrameRect={localFrameRect}
          points={points}
          state={state}
          editing={editing}
          validDraft={validDraft}
          selectedIndex={selectedIndex}
          tool={tool}
          drawStart={drawStart}
          previewPoint={previewPoint}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        <div className="video-corner-label">
          <span className="status-dot is-live" aria-hidden="true" />
          CAM-01 · STILL PREVIEW
        </div>
        <div className="video-sim-overlay">
          <SimulationBadge />
          <span>Generated still · live stream not connected</span>
        </div>
      </div>

      {editing ? (
        <div className="roi-editor-panel">
          <div className="roi-editor-toolbar">
            <div className="roi-editor-tools">
              <span className="toolbar-label">DRAW TOOL</span>
              <ToggleGroup
                multiple={false}
                value={[tool]}
                onValueChange={handleToolChange}
                variant="outline"
                size="sm"
                aria-label="Region editing tool"
              >
                <ToggleGroupItem value="select" aria-label="Select and move region points">
                  <MousePointer2 data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Select
                </ToggleGroupItem>
                <ToggleGroupItem value="rectangle" aria-label="Draw rectangular region">
                  <Square data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Rectangle
                </ToggleGroupItem>
                <ToggleGroupItem value="polygon" aria-label="Draw polygon region">
                  <Pentagon data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Polygon
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="roi-editor-tools roi-editor-tools-right">
              <span className="snap-status">Snap to pixel <strong>Off</strong></span>
              <Button size="sm" variant="ghost" type="button" onClick={handleUndo} disabled={undoCount === 0}>
                <Undo2 data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Undo
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={handleDelete} disabled={draft.length === 0}>
                <Trash2 data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Delete
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={handleReset}>
                <RotateCcw data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Reset
              </Button>
            </div>
          </div>

          <div className="roi-editor-footer">
            <p className={`roi-validation ${validDraft ? "" : "is-invalid"}`} aria-live="polite">
              {draft.length === 0
                ? "No region selected. Draw a rectangle or polygon to continue."
                : validDraft
                  ? `${draft.length} normalized points · keyboard arrows move a selected handle; Shift + arrow moves 10 px.`
                  : "Region is invalid. Check for self-intersections and add at least three points."}
            </p>
            <div className="roi-editor-actions">
              <Button size="sm" variant="outline" type="button" onClick={() => setShowCrop((value) => !value)} disabled={!canTestCrop}>
                <Crop data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />
                {showCrop ? "Hide crop" : "Test crop"}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={onCancel}>
                <X data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Cancel
              </Button>
              <Button size="sm" type="button" onClick={() => onSave(copyRegion(draft))} disabled={!validDraft}>
                <Check data-icon="inline-start" strokeWidth={1.75} aria-hidden="true" />Save region
              </Button>
            </div>
          </div>

          {showCrop && cropStyle && (
            <div className="crop-preview-card">
              <div className="crop-preview-image" style={cropStyle} role="img" aria-label="Simulated local crop preview">
                <span className="crop-preview-mark">SIMULATED</span>
              </div>
              <div className="crop-preview-copy">
                <strong>Local crop approximation</strong>
                <span>This preview is generated in the browser. The backend crop endpoint is not connected.</span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="video-status-bar">
          <span><span className="mono-label">SOURCE</span> Generated still · no stream API connected</span>
          <span className="mono-label">NORMALIZED REGION</span>
        </div>
      )}
    </div>
  )
}

function copyRegion(points: NormalizedPoint[]): NormalizedPoint[] {
  return points.map(([x, y]) => [x, y] as NormalizedPoint)
}

function distance(a: NormalizedPoint, b: NormalizedPoint) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function cropPosition(min: number, size: number) {
  if (size >= 1) return 0
  return Math.max(0, Math.min(100, (min / (1 - size)) * 100))
}
