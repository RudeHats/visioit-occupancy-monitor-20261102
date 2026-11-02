"use client"

import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Panel } from "@/components/monitoring/ui"
import type { PreviewSettings } from "@/lib/monitoring/domain"

export type PreviewSettingsErrors = Partial<Record<keyof PreviewSettings, string>>

export function ThresholdForm({
  settings,
  errors,
  onChange,
}: {
  settings: PreviewSettings
  errors: PreviewSettingsErrors
  onChange: <K extends keyof PreviewSettings>(key: K, value: PreviewSettings[K]) => void
}) {
  return (
    <Panel title="Detection thresholds" subtitle="Preview-only controls · not sent to a service" simulated>
      <FieldSet className="settings-fieldset">
        <FieldLegend>Vacancy and confidence</FieldLegend>
        <FieldGroup>
          <Field data-invalid={Boolean(errors.vacancyDurationSeconds)}>
            <FieldLabel htmlFor="vacancy-duration">Vacancy duration</FieldLabel>
            <div className="setting-control-row">
              <Input
                id="vacancy-duration"
                type="number"
                min={30}
                max={3600}
                step={1}
                value={settings.vacancyDurationSeconds}
                onChange={(event) => onChange("vacancyDurationSeconds", Number(event.target.value))}
                aria-invalid={Boolean(errors.vacancyDurationSeconds)}
                aria-describedby="vacancy-duration-help"
              />
              <span className="unit-label">seconds</span>
            </div>
            <FieldDescription id="vacancy-duration-help">How long a seat must remain vacant before an alert is considered.</FieldDescription>
            <FieldError>{errors.vacancyDurationSeconds}</FieldError>
          </Field>

          <Field data-invalid={Boolean(errors.confidenceThreshold)}>
            <FieldLabel htmlFor="confidence-threshold">Confidence threshold</FieldLabel>
            <div className="setting-control-row setting-slider-row">
              <Slider
                id="confidence-threshold"
                min={0}
                max={1}
                step={0.01}
                value={[settings.confidenceThreshold]}
                onValueChange={(value) => onChange("confidenceThreshold", typeof value === "number" ? value : value[0] ?? settings.confidenceThreshold)}
                aria-label="Confidence threshold"
                aria-describedby="confidence-threshold-help"
              />
              <output className="setting-output" htmlFor="confidence-threshold">
                {(settings.confidenceThreshold * 100).toFixed(0)}%
              </output>
            </div>
            <FieldDescription id="confidence-threshold-help">Minimum confidence required for a sample seat state.</FieldDescription>
            <FieldError>{errors.confidenceThreshold}</FieldError>
          </Field>

          <Field data-invalid={Boolean(errors.alertCooldownSeconds)}>
            <FieldLabel htmlFor="alert-cooldown">Alert cooldown</FieldLabel>
            <div className="setting-control-row setting-slider-row">
              <Slider
                id="alert-cooldown"
                min={0}
                max={3600}
                step={30}
                value={[settings.alertCooldownSeconds]}
                onValueChange={(value) => onChange("alertCooldownSeconds", typeof value === "number" ? value : value[0] ?? settings.alertCooldownSeconds)}
                aria-label="Alert cooldown"
                aria-describedby="alert-cooldown-help"
              />
              <output className="setting-output" htmlFor="alert-cooldown">
                {formatSeconds(settings.alertCooldownSeconds)}
              </output>
            </div>
            <FieldDescription id="alert-cooldown-help">Minimum time between repeated vacancy alert tones for the same seat.</FieldDescription>
            <FieldError>{errors.alertCooldownSeconds}</FieldError>
          </Field>
        </FieldGroup>
      </FieldSet>
    </Panel>
  )
}

function formatSeconds(seconds: number) {
  if (seconds === 0) return "Off"
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`
}
