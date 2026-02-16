import { useState, useRef, useEffect } from "react"
import { PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLogs, type LogEntry, type LogLevel } from "@/contexts/LogsContext"

const levelColors: Record<LogLevel, string> = {
  info: "text-foreground",
  warn: "text-yellow-600 dark:text-yellow-500",
  error: "text-destructive",
  debug: "text-muted-foreground",
}

function formatTime(d: Date) {
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

export function LogsPanel() {
  const { logs, clearLogs } = useLogs()
  const [expanded, setExpanded] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [logs.length])

  if (!expanded) {
    return (
      <div className="w-10 shrink-0 border-l bg-card flex flex-col items-center py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setExpanded(true)}
          title="Show logs"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="w-80 shrink-0 border-l bg-card flex flex-col min-w-[200px] max-w-[50vw]">
      <div className="flex items-center justify-between px-2 py-2 border-b">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Logs
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={clearLogs}
            title="Clear logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setExpanded(false)}
            title="Hide logs"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden font-mono text-xs p-2 min-h-[120px]"
      >
        {logs.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center">No logs yet</p>
        ) : (
          <div className="space-y-1">
            {logs.map((log) => (
              <LogLine key={log.id} entry={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div
      className={`flex gap-2 py-0.5 break-words ${levelColors[entry.level]}`}
      title={entry.message}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {formatTime(entry.timestamp)}
      </span>
      <span className="min-w-0">{entry.message}</span>
    </div>
  )
}
