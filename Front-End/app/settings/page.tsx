"use client"

import { useState, type FormEvent } from "react"
import { AlertTriangle, Check, RotateCcw, Volume2, Wifi } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ErrorState } from "@/components/monitoring/error-state"
import { PageHeader, Panel } from "@/components/monitoring/ui"
import { SourceSelector } from "@/components/monitoring/source-selector"
import { ThresholdForm, type PreviewSettingsErrors } from "@/components/monitoring/threshold-form"
import { defaultPreviewSettings, mockEnabled, useMonitoringStore } from "@/lib/monitoring/store"
import { previewSettingsSchema, type PreviewSettings } from "@/lib/monitoring/domain"
import { enableAlertAudio, playAlertTone } from "@/lib/monitoring/alert-audio"
import { api, streamUrl } from "@/lib/monitoring/api"

export default function SettingsPage() {
  const settings = useMonitoringStore((state) => state.settings)
  const updateSettings = useMonitoringStore((state) => state.updateSettings)
  const switchSource = useMonitoringStore((state) => state.switchSource)
  const soundUnlocked = useMonitoringStore((state) => state.soundUnlocked)
  const soundBlocked = useMonitoringStore((state) => state.soundBlocked)
  const setSoundUnlocked = useMonitoringStore((state) => state.setSoundUnlocked)
  const setSoundBlocked = useMonitoringStore((state) => state.setSoundBlocked)
  const connectionStatus = useMonitoringStore((state) => state.connection.status)
  const modelInfo = useMonitoringStore((state) => state.modelInfo)
  const [draft, setDraft] = useState<PreviewSettings>(settings)
  const [errors, setErrors] = useState<PreviewSettingsErrors>({})
  const [saveMessage, setSaveMessage] = useState("")
  const [audioMessage, setAudioMessage] = useState("")

  const handleChange = <K extends keyof PreviewSettings>(key: K, value: PreviewSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setErrors((current) => ({ ...current, [key]: undefined }))
    setSaveMessage("")
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = previewSettingsSchema.safeParse(draft)

    if (!result.success) {
      const nextErrors: PreviewSettingsErrors = {}
      for (const issue of result.error.issues) {
        const key = issue.path[0]
        if (typeof key === "string") nextErrors[key as keyof PreviewSettings] = issue.message
      }
      setErrors(nextErrors)
      setSaveMessage("")
      return
    }

    setErrors({})
    if (mockEnabled) {
      updateSettings(result.data)
      setSaveMessage("Preview settings saved.")
      return
    }
    void (async () => {
      try {
        await api.settingsPut({
          vacancy_seconds: result.data.vacancyDurationSeconds,
          cooldown_seconds: result.data.alertCooldownSeconds,
          occupied_conf: result.data.confidenceThreshold,
        })
        updateSettings(result.data)
        await switchSource(result.data.source)
        setSaveMessage("Settings saved. Camera connection status is shown in the preview.")
      } catch (error) {
        setSaveMessage(error instanceof Error ? error.message : "Could not apply settings.")
      }
    })()
  }

  const handleReset = () => {
    setDraft({ ...defaultPreviewSettings })
    setErrors({})
    setSaveMessage("Preview defaults loaded. Save to apply them to this session.")
  }

  const handleEnableAudio = async () => {
    const unlocked = await enableAlertAudio()
    setSoundUnlocked(unlocked)
    setSoundBlocked(!unlocked)
    setAudioMessage(unlocked ? "Alert audio is enabled after your browser gesture." : "Audio could not be enabled. Check browser sound permissions.")
  }

  const handleTestSound = () => {
    if (!soundUnlocked) {
      setAudioMessage("Enable alert sound first; browsers block audio until a user gesture.")
      return
    }

    const played = playAlertTone(draft.soundVolume / 100)
    if (played) {
      setAudioMessage("Two-tone test played. Routine state changes remain silent.")
    } else {
      setSoundBlocked(true)
      setAudioMessage("Audio is blocked by the browser. Enable it again to retry.")
    }
  }

  if (!mockEnabled && connectionStatus !== "connected" && connectionStatus !== "reconnecting") {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="CONFIGURATION" title="Settings" description="Configure source, thresholds, and alert behavior." />
        <ErrorState />
      </div>
    )
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="CONFIGURATION"
        title="Settings"
        description="Configure the active backend source, detection thresholds, and alert behavior."
      />

      <form className="settings-layout" onSubmit={handleSubmit} noValidate>
        <div className="settings-main-column">
          <SourceSelector
            source={draft.source}
            sourceUrl={draft.sourceUrl}
            usbIndex={draft.usbIndex}
            onSourceUrlChange={(value) => handleChange("sourceUrl", value)}
            onUsbIndexChange={(value) => handleChange("usbIndex", value)}
            onChange={(source) => handleChange("source", source)}
          />
          <ThresholdForm settings={draft} errors={errors} onChange={handleChange} />

          <Panel title="Alert audio" subtitle="Browser audio requires an explicit user gesture." simulated={false}>
            {soundBlocked && (
              <Alert className="sound-blocked-alert">
                <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />
                <div>
                  <AlertTitle>Audio is blocked</AlertTitle>
                  <AlertDescription>Enable alert sound from this page or the top bar before testing a tone.</AlertDescription>
                </div>
              </Alert>
            )}

            <FieldGroup>
              <Field className="sound-toggle-row">
                <div className="sound-toggle-copy">
                  <FieldLabel htmlFor="alert-sound-toggle">Sound enabled</FieldLabel>
                  <FieldDescription>Only warning or critical vacancy alerts can play a tone.</FieldDescription>
                </div>
                <Switch
                  id="alert-sound-toggle"
                  checked={draft.soundEnabled}
                  onCheckedChange={(checked) => handleChange("soundEnabled", checked)}
                  aria-label="Enable vacancy alert sound"
                />
              </Field>

              <Field data-disabled={!draft.soundEnabled}>
                <FieldLabel htmlFor="alert-volume">Alert volume</FieldLabel>
                <div className="setting-control-row setting-slider-row">
                  <Slider
                    id="alert-volume"
                    min={0}
                    max={100}
                    step={1}
                    value={[draft.soundVolume]}
                    onValueChange={(value) => handleChange("soundVolume", typeof value === "number" ? value : value[0] ?? draft.soundVolume)}
                    disabled={!draft.soundEnabled}
                    aria-label="Alert sound volume"
                  />
                  <output className="setting-output" htmlFor="alert-volume">{draft.soundVolume}%</output>
                </div>
                <FieldDescription>Audio is synthesized locally with the Web Audio API.</FieldDescription>
              </Field>
            </FieldGroup>

            <div className="audio-actions">
              {!soundUnlocked && (
                <Button type="button" variant="outline" onClick={() => void handleEnableAudio()}>
                  <Volume2 data-icon="inline-start" aria-hidden="true" />Enable alert sound
                </Button>
              )}
              <Button type="button" variant="outline" onClick={handleTestSound} disabled={!draft.soundEnabled || !soundUnlocked}>
                <Volume2 data-icon="inline-start" aria-hidden="true" />Test sound
              </Button>
            </div>
            {audioMessage && <p className="inline-status-message" role="status">{audioMessage}</p>}
          </Panel>
        </div>

        <aside className="settings-side-column">
          <Panel title="Model selection" subtitle="Reported from the active backend." simulated={false}>
            <FieldGroup>
              <Field data-disabled>
                <FieldLabel htmlFor="deployed-model">Deployed model</FieldLabel>
                <Input id="deployed-model" value={modelInfo?.name ?? "Loading…"} disabled readOnly />
                <FieldDescription>Model and device metadata update from the backend connection.</FieldDescription>
              </Field>
            </FieldGroup>
            <div className="settings-model-note">
              <span className="status-dot is-neutral" aria-hidden="true" />
              <span>Selection controls will be enabled when the backend contract provides model options.</span>
            </div>
          </Panel>

          <Panel title="Camera preview" subtitle="The currently selected backend source" simulated={false}>
            <div className="settings-camera-preview">
              <img src={streamUrl("cam0")} alt="Live preview from selected camera source" />
              <div><Wifi size={14} aria-hidden="true" /> {connectionStatus === "connected" ? "Live backend preview" : "Waiting for backend frames"}</div>
            </div>
          </Panel>

          <Panel title="Preview status" subtitle="Live runtime status" simulated={false}>
            <div className="settings-status-list">
              <div><span>Camera source</span><strong>{draft.source}</strong></div>
              <div><span>Backend API</span><strong>{connectionStatus}</strong></div>
              <div><span>Event persistence</span><strong>Backend session</strong></div>
              <div><span>Browser storage</span><strong>Settings saved</strong></div>
            </div>
          </Panel>

          <Panel title="Apply settings" subtitle="Saved until explicitly changed." simulated={false}>
            <div className="settings-save-actions">
              <Button type="submit">
                <Check data-icon="inline-start" aria-hidden="true" />Save settings
              </Button>
              <Button type="button" variant="outline" onClick={handleReset}>
                <RotateCcw data-icon="inline-start" aria-hidden="true" />Reset defaults
              </Button>
            </div>
            {saveMessage && <p className="inline-status-message" role="status">{saveMessage}</p>}
          </Panel>
        </aside>
      </form>

      <div className="page-footnote">
        <AlertTriangle size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>Source selection is persisted in this browser and reapplied when the backend reconnects. Credentials are sent only to the configured backend.</span>
      </div>
    </div>
  )
}
