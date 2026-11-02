"use client"

import { useState } from "react"
import { Camera, FileVideo, Radio } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Panel } from "@/components/monitoring/ui"
import type { PreviewSettings } from "@/lib/monitoring/domain"

export function SourceSelector({
  source,
  sourceUrl,
  usbIndex,
  onSourceUrlChange,
  onUsbIndexChange,
  onChange,
}: {
  source: PreviewSettings["source"]
  sourceUrl: string
  usbIndex: number
  onSourceUrlChange: (value: string) => void
  onUsbIndexChange: (value: number) => void
  onChange: (source: PreviewSettings["source"]) => void
}) {
  const [fileName, setFileName] = useState("")

  return (
    <Panel title="Camera source" subtitle="Choose and persist the backend source" simulated={false}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="camera-source">Source type</FieldLabel>
          <Select value={source} onValueChange={(value) => {
            if (value === "synthetic" || value === "usb" || value === "rtsp" || value === "file") onChange(value)
          }}>
            <SelectTrigger id="camera-source" className="w-full">
              <SelectValue placeholder="Select a source" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="synthetic">Synthetic preview</SelectItem>
                <SelectItem value="usb">USB camera</SelectItem>
                <SelectItem value="rtsp">RTSP stream</SelectItem>
                <SelectItem value="file">Video file</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Only the generated still is available in this local preview.</FieldDescription>
        </Field>

        {source === "synthetic" && (
          <Alert className="source-preview-note">
            <Camera size={15} strokeWidth={1.75} aria-hidden="true" />
            <div>
              <AlertTitle>Generated preview image</AlertTitle>
              <AlertDescription>No camera feed is opened and no frames are transmitted.</AlertDescription>
            </div>
          </Alert>
        )}

        {source === "usb" && (
          <Field>
            <FieldLabel htmlFor="usb-index">USB camera index</FieldLabel>
            <Input id="usb-index" type="number" min={0} step={1} value={usbIndex} onChange={(event) => onUsbIndexChange(Number(event.target.value) || 0)} />
            <FieldDescription>Index is resolved by the backend host and retained between reloads.</FieldDescription>
          </Field>
        )}

        {source === "rtsp" && (
          <Field>
            <FieldLabel htmlFor="rtsp-address">RTSP address</FieldLabel>
            <Input
              id="rtsp-address"
              type="url"
              value={sourceUrl}
              onChange={(event) => onSourceUrlChange(event.target.value)}
              placeholder="rtsp://camera-host/stream"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>Saved locally and sent to the backend when applied.</FieldDescription>
          </Field>
        )}

        {source === "file" && (
          <Field>
            <FieldLabel htmlFor="video-file">Video file</FieldLabel>
            <Input
              id="video-file"
              type="file"
              accept="video/*"
              onChange={(event) => setFileName(event.target.files?.[0]?.name ?? "")}
            />
            <FieldDescription>
              {fileName ? `${fileName} selected locally; playback is not connected.` : "Selection is local only; the file is not uploaded or processed."}
            </FieldDescription>
            <FileVideo size={14} strokeWidth={1.75} className="source-file-icon" aria-hidden="true" />
          </Field>
        )}
      </FieldGroup>
    </Panel>
  )
}
