import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { StatusBadge } from "../components/monitoring/status-badge"
import { seatStateSchema } from "../lib/monitoring/domain"

afterEach(cleanup)

describe("seat state presentation", () => {
  it("shows camera unavailability as unavailable, never vacant", () => {
    render(<StatusBadge state="camera_unavailable" />)

    expect(screen.getByText("Camera unavailable")).toBeTruthy()
    expect(screen.queryByText("Vacant")).toBeNull()
  })

  it("keeps vacancy alerts separate from seat states", () => {
    expect(seatStateSchema.safeParse("vacancy_alert").success).toBe(false)
    expect(seatStateSchema.safeParse("vacant").success).toBe(true)
  })

  it("labels a model error without implying vacancy", () => {
    render(<StatusBadge state="model_error" />)

    expect(screen.getByText("Model error")).toBeTruthy()
    expect(screen.queryByText("Vacant")).toBeNull()
  })
})
