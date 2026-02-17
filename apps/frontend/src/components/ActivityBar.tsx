import { Button } from "@/components/ui/button"
import type { LucideIcon } from "lucide-react"

export function ActivityBar({
  items,
  orientation = "horizontal",
  className = "",
}: {
  items: Array<{
    id: string
    icon: LucideIcon
    label: string
    active: boolean
    onClick: () => void
  }>
  orientation?: "horizontal" | "vertical"
  className?: string
}) {
  if (orientation === "horizontal") {
    return (
      <div className={`flex flex-row items-center gap-1 px-2 py-1 border-b border-border bg-panel-1 shrink-0 ${className}`}>
        {items.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            className={`h-8 w-8 ${item.active ? "bg-muted" : ""}`}
            onClick={item.onClick}
            title={item.label}
          >
            <item.icon className="h-4 w-4" />
          </Button>
        ))}
      </div>
    )
  }

  return (
    <div
      className={`flex flex-col items-center pt-16 pb-2 border-r border-border bg-panel-1 shrink-0 ${className}`}
      style={{ width: 48 }}
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          size="icon"
          className={`h-9 w-9 mb-1 ${item.active ? "bg-muted" : ""}`}
          onClick={item.onClick}
          title={item.label}
        >
          <item.icon className="h-4 w-4" />
        </Button>
      ))}
    </div>
  )
}
