import type { MonitorEvent } from "./domain"

export function dedupeAlerts<T extends { id: string }>(events: T[]): T[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    if (seen.has(event.id)) return false
    seen.add(event.id)
    return true
  })
}

export function canPlayAlert(
  event: Pick<MonitorEvent, "type" | "severity" | "acknowledged" | "snoozedUntil">,
  options: { now: number; cooldownSeconds: number; lastPlayedAt?: number },
): boolean {
  const isWarningOrHigher = event.severity === "warning" || event.severity === "critical"
  const isVacancyAlert = event.type === "vacancy_confirmed"
  const isSnoozed = event.snoozedUntil !== undefined && event.snoozedUntil > options.now
  const isCoolingDown =
    options.lastPlayedAt !== undefined &&
    options.now - options.lastPlayedAt < options.cooldownSeconds * 1000

  return isVacancyAlert && isWarningOrHigher && !event.acknowledged && !isSnoozed && !isCoolingDown
}

export async function unlockAudioContext(
  context: Pick<AudioContext, "state" | "resume">,
): Promise<boolean> {
  if (context.state === "closed") return false

  try {
    if (context.state !== "running") await context.resume()
    return context.state === "running"
  } catch {
    return false
  }
}
