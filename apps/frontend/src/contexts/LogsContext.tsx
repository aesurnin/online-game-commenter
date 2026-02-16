import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react"

export type LogLevel = "info" | "warn" | "error" | "debug"

export type LogEntry = {
  id: string
  timestamp: Date
  message: string
  level: LogLevel
}

type LogsContextValue = {
  logs: LogEntry[]
  addLog: (message: string, level?: LogLevel) => void
  clearLogs: () => void
}

const LogsContext = createContext<LogsContextValue | null>(null)

export function LogsProvider({ children }: { children: ReactNode }) {
  const [logs, setLogs] = useState<LogEntry[]>([])

  const addLog = useCallback((message: string, level: LogLevel = "info") => {
    setLogs((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        message,
        level,
      },
    ])
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  return (
    <LogsContext.Provider value={{ logs, addLog, clearLogs }}>
      {children}
    </LogsContext.Provider>
  )
}

export function useLogs() {
  const ctx = useContext(LogsContext)
  if (!ctx) throw new Error("useLogs must be used within LogsProvider")
  return ctx
}

