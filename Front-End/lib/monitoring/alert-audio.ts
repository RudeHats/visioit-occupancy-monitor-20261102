import { unlockAudioContext } from "./alerts"

let audioContext: AudioContext | null = null
let activeOscillators: OscillatorNode[] = []

export function stopAlertTone() {
  for (const oscillator of activeOscillators) {
    try {
      oscillator.stop()
    } catch {
      continue
    }
  }
  activeOscillators = []
}

export async function enableAlertAudio(): Promise<boolean> {
  if (typeof window === "undefined" || !window.AudioContext) return false

  try {
    audioContext ??= new window.AudioContext()
    return await unlockAudioContext(audioContext)
  } catch {
    return false
  }
}

export function playAlertTone(volume: number): boolean {
  if (!audioContext || audioContext.state !== "running") return false

  const now = audioContext.currentTime
  const oscillator = audioContext.createOscillator()
  const gain = audioContext.createGain()
  const safeVolume = Math.min(1, Math.max(0, volume))

  oscillator.type = "sine"
  oscillator.frequency.setValueAtTime(740, now)
  oscillator.frequency.setValueAtTime(880, now + 0.12)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, safeVolume * 0.12), now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
  oscillator.connect(gain)
  gain.connect(audioContext.destination)
  activeOscillators.push(oscillator)
  oscillator.onended = () => {
    activeOscillators = activeOscillators.filter((active) => active !== oscillator)
  }
  oscillator.start(now)
  oscillator.stop(now + 0.34)

  return true
}
