import { describe, expect, it, vi } from "vitest"

import { canPlayAlert, dedupeAlerts, unlockAudioContext } from "../lib/monitoring/alerts"
import type { MonitorEvent } from "../lib/monitoring/domain"

const vacancyAlert: MonitorEvent = {
  id: "alert-1",
  type: "vacancy_confirmed",
  severity: "warning",
  seatId: "A-04",
  seatName: "A-04 · North row",
  timeLabel: "Just now",
  description: "Seat remained empty beyond the preview threshold.",
  vacantForSeconds: 242,
  ageMinutes: 0,
  acknowledged: false,
}

describe("vacancy alert behavior", () => {
  it("deduplicates events by ID", () => {
    expect(dedupeAlerts([vacancyAlert, vacancyAlert])).toEqual([vacancyAlert])
  })

  it("plays only warning-or-higher vacancy alerts outside cooldown", () => {
    expect(canPlayAlert(vacancyAlert, { now: 10_000, cooldownSeconds: 30 })).toBe(true)
    expect(canPlayAlert({ ...vacancyAlert, severity: "info" }, { now: 10_000, cooldownSeconds: 30 })).toBe(false)
    expect(canPlayAlert({ ...vacancyAlert, acknowledged: true }, { now: 10_000, cooldownSeconds: 30 })).toBe(false)
    expect(canPlayAlert(vacancyAlert, { now: 10_000, cooldownSeconds: 30, lastPlayedAt: 9_000 })).toBe(false)
    expect(canPlayAlert(vacancyAlert, { now: 40_000, cooldownSeconds: 30, lastPlayedAt: 9_000 })).toBe(true)
  })

  it("does not play a snoozed alert", () => {
    expect(
      canPlayAlert(
        { ...vacancyAlert, snoozedUntil: 20_000 },
        { now: 10_000, cooldownSeconds: 30 },
      ),
    ).toBe(false)
  })

  it("unlocks suspended browser audio only after a user gesture", async () => {
    let state: AudioContextState = "suspended"
    const resume = vi.fn(async () => {
      state = "running"
    })
    const context = {
      get state() {
        return state
      },
      resume,
    }

    await expect(unlockAudioContext(context)).resolves.toBe(true)
    expect(resume).toHaveBeenCalledOnce()
  })

  it("handles a browser that blocks audio unlock", async () => {
    const context = {
      state: "suspended" as AudioContextState,
      resume: vi.fn(async () => {
        throw new Error("Audio is blocked")
      }),
    }

    await expect(unlockAudioContext(context)).resolves.toBe(false)
  })
})
