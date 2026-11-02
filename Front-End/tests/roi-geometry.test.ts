import { describe, expect, it } from "vitest"

import {
  clientToNormalized,
  getContainRect,
  isValidPolygon,
  normalizedToClient,
  rectangleToPolygon,
} from "../lib/roi-geometry"

describe("normalized ROI geometry", () => {
  it("fits a wide frame inside a square without stretching", () => {
    const fitted = getContainRect(
      { left: 0, top: 0, width: 400, height: 400 },
      { width: 1600, height: 900 },
    )

    expect(fitted).toEqual({ left: 0, top: 87.5, width: 400, height: 225 })
    expect(clientToNormalized(200, 200, fitted)).toEqual([0.5, 0.5])
  })

  it("fits a tall frame inside a wide container with horizontal letterboxing", () => {
    const fitted = getContainRect(
      { left: 10, top: 20, width: 400, height: 200 },
      { width: 900, height: 1600 },
    )

    expect(fitted).toEqual({ left: 153.75, top: 20, width: 112.5, height: 200 })
  })

  it("preserves a normalized point across resized frames", () => {
    const normalized: [number, number] = [0.25, 0.75]
    const firstFrame = getContainRect(
      { left: 0, top: 0, width: 400, height: 225 },
      { width: 1600, height: 900 },
    )
    const secondFrame = getContainRect(
      { left: 0, top: 0, width: 800, height: 450 },
      { width: 1600, height: 900 },
    )

    const firstClientPoint = normalizedToClient(normalized, firstFrame)
    const secondClientPoint = normalizedToClient(normalized, secondFrame)

    expect(clientToNormalized(firstClientPoint.x, firstClientPoint.y, firstFrame)).toEqual(normalized)
    expect(clientToNormalized(secondClientPoint.x, secondClientPoint.y, secondFrame)).toEqual(normalized)
  })

  it("creates a normalized rectangle regardless of drag direction", () => {
    expect(rectangleToPolygon([0.8, 0.7], [0.1, 0.2])).toEqual([
      [0.1, 0.2],
      [0.8, 0.2],
      [0.8, 0.7],
      [0.1, 0.7],
    ])
  })

  it("rejects polygons with fewer than three points, out-of-bounds points, or self-intersections", () => {
    expect(isValidPolygon([[0.1, 0.1], [0.9, 0.1]])).toBe(false)
    expect(isValidPolygon([[0.1, 0.1], [1.1, 0.1], [0.5, 0.9]])).toBe(false)
    expect(isValidPolygon([[0.1, 0.1], [0.9, 0.9], [0.1, 0.9], [0.9, 0.1]])).toBe(false)
    expect(isValidPolygon([[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])).toBe(true)
  })
})
