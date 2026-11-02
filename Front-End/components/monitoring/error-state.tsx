import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { WifiOff } from "lucide-react"

export function ErrorState({
  title = "Backend is not connected",
  description = "API and live-stream wiring are waiting for the required integration contract. Set NEXT_PUBLIC_USE_MOCK=true in a development preview to show clearly labeled sample data.",
}: {
  title?: string
  description?: string
}) {
  return (
    <Alert className="connection-alert" role="status">
      <WifiOff size={16} strokeWidth={1.75} aria-hidden="true" />
      <div>
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
      </div>
    </Alert>
  )
}
