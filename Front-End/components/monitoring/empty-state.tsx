import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = "",
}: {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
  className?: string
}) {
  return (
    <Empty className={`empty-state ${className}`}>
      <EmptyHeader>
        <EmptyMedia className="empty-state-icon" variant="icon">
          <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="empty-state-title">{title}</EmptyTitle>
        <EmptyDescription className="empty-state-description">{description}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
