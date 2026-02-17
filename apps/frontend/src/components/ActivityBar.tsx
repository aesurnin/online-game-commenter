import { Button } from "@/components/ui/button"
import type { LucideIcon } from "lucide-react"

export function ActivityBar({
  items,
  orientation = "horizontal",
  side = "left",
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
  side?: "left" | "right"
  className?: string
}) {
  if (items.length === 0) return null
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

  const isRight = side === "right"
  return (
    <div
      className={`flex flex-col items-center pt-16 pb-2 border-border bg-panel-1 shrink-0 ${isRight ? "border-l" : "border-r"} ${className}`}
      style={{ width: 48 }}
    >
      {items.map((item) => (
        <div key={item.id} className="relative w-full flex justify-center mb-1">
          {item.active && (
            <div className={`absolute top-1/2 -translate-y-1/2 w-0.5 h-6 bg-primary ${isRight ? "right-0 rounded-l" : "left-0 rounded-r"}`} />
          )}
          <Button
            variant="ghost"
            size="icon"
            className={`h-9 w-9 transition-colors ${
              item.active 
                ? "bg-muted hover:bg-muted/80 text-foreground" 
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            onClick={item.onClick}
            title={item.label}
          >
            <item.icon className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  )
}
