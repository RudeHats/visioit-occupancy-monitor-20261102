import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function DashboardSkeleton() {
  return (
    <div className="page-stack" aria-label="Loading monitoring dashboard">
      <div className="page-heading">
        <div className="page-heading-copy">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <div className="kpi-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <Card className="panel" key={index}>
            <CardHeader className="panel-header">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="size-8 rounded-lg" />
            </CardHeader>
            <CardContent className="panel-content">
              <Skeleton className="h-8 w-16" />
              <Skeleton className="mt-3 h-8 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
