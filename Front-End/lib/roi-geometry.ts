import type { NormalizedPoint } from "./monitoring/domain"

export type Rect = {
  left: number
  top: number
  width: number
  height: number
}

export type FrameSize = {
  width: number
  height: number
}

export function getContainRect(
  container: Rect,
  frame: FrameSize,
): Rect {
  if (container.width <= 0 || container.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { left: container.left, top: container.top, width: 0, height: 0 }
  }

  const scale = Math.min(container.width / frame.width, container.height / frame.height)
  const width = frame.width * scale
  const height = frame.height * scale

  return {
    left: container.left + (container.width - width) / 2,
    top: container.top + (container.height - height) / 2,
    width,
    height,
  }
}

export function clampPoint(point: NormalizedPoint): NormalizedPoint {
  return [clampUnit(point[0]), clampUnit(point[1])]
}

export function normalizedToClient(point: NormalizedPoint, frameRect: Rect) {
  return {
    x: frameRect.left + clampUnit(point[0]) * frameRect.width,
    y: frameRect.top + clampUnit(point[1]) * frameRect.height,
  }
}

export function clientToNormalized(
  clientX: number,
  clientY: number,
  frameRect: Rect,
): NormalizedPoint | null {
  if (frameRect.width <= 0 || frameRect.height <= 0) return null

  const x = (clientX - frameRect.left) / frameRect.width
  const y = (clientY - frameRect.top) / frameRect.height

  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return [x, y]
}

export function rectangleToPolygon(
  start: NormalizedPoint,
  end: NormalizedPoint,
): NormalizedPoint[] {
  const left = Math.min(start[0], end[0])
  const right = Math.max(start[0], end[0])
  const top = Math.min(start[1], end[1])
  const bottom = Math.max(start[1], end[1])

  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ]
}

export function getPolygonBounds(points: NormalizedPoint[]) {
  if (points.length === 0) return null
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY }
}

export function isValidPolygon(points: NormalizedPoint[]): boolean {
  if (points.length < 3) return false
  if (points.some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1)) return false

  for (let first = 0; first < points.length; first += 1) {
    const firstNext = (first + 1) % points.length
    for (let second = first + 1; second < points.length; second += 1) {
      const secondNext = (second + 1) % points.length
      if (first === second || firstNext === second || secondNext === first) continue
      if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext])) {
        return false
      }
    }
  }

  return true
}

function segmentsIntersect(
  a: NormalizedPoint,
  b: NormalizedPoint,
  c: NormalizedPoint,
  d: NormalizedPoint,
): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  const epsilon = 1e-9

  if (abC * abD < -epsilon && cdA * cdB < -epsilon) return true
  if (Math.abs(abC) <= epsilon && onSegment(a, c, b)) return true
  if (Math.abs(abD) <= epsilon && onSegment(a, d, b)) return true
  if (Math.abs(cdA) <= epsilon && onSegment(c, a, d)) return true
  if (Math.abs(cdB) <= epsilon && onSegment(c, b, d)) return true
  return false
}

function orientation(a: NormalizedPoint, b: NormalizedPoint, c: NormalizedPoint) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: NormalizedPoint, point: NormalizedPoint, b: NormalizedPoint) {
  return (
    point[0] >= Math.min(a[0], b[0]) &&
    point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) &&
    point[1] <= Math.max(a[1], b[1])
  )
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
