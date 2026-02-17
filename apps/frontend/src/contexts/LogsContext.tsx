import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
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
  addLog: (message: string, level?: LogLevel, videoId?: string) => void
  clearLogs: () => void
  activeVideoId: string | null
  setActiveVideoId: (id: string | null) => void
  fetchLogsForVideo: (projectId: string, videoId: string) => Promise<void>
}

const LogsContext = createContext<LogsContextValue | null>(null)

export function LogsProvider({ children }: { children: ReactNode }) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsByVideoId, setLogsByVideoId] = useState<Record<string, LogEntry[]>>({})
  const [activeVideoId, setActiveVideoIdState] = useState<string | null>(null)
  const knownBackendIds = useRef<Record<string, Set<string>>>({})

  const setActiveVideoId = useCallback((id: string | null) => {
    setActiveVideoIdState(id)
  }, [])

  const addLog = useCallback((message: string, level: LogLevel = "info", videoId?: string) => {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      message,
      level,
    }
    if (videoId) {
      setLogsByVideoId((prev) => ({
        ...prev,
        [videoId]: [...(prev[videoId] ?? []), entry],
      }))
    } else {
      setLogs((prev) => [...prev, entry])
    }
  }, [])

  const mergeBackendLogs = useCallback((videoId: string, backendLogs: { id: string; timestamp: string; message: string }[]) => {
    const known = knownBackendIds.current[videoId] ?? new Set<string>()
    const toAdd: LogEntry[] = []
    for (const log of backendLogs) {
      if (!known.has(log.id)) {
        known.add(log.id)
        toAdd.push({
          id: log.id,
          timestamp: new Date(log.timestamp),
          message: log.message,
          level: "info",
        })
      }
    }
    if (toAdd.length > 0) {
      knownBackendIds.current[videoId] = known
      setLogsByVideoId((prev) => {
        const existing = prev[videoId] ?? []
        const merged = [...existing, ...toAdd].sort(
          (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
        )
        return { ...prev, [videoId]: merged }
      })
    }
  }, [])

  const fetchLogsForVideo = useCallback(async (projectId: string, videoId: string) => {
    try {
      const r = await fetch(`/api/projects/${projectId}/videos/${videoId}/logs`, {
        credentials: "include",
      })
      if (r.ok) {
        const data = await r.json()
        if (data.logs?.length) mergeBackendLogs(videoId, data.logs)
      }
    } catch {
      // ignore
    }
  }, [mergeBackendLogs])

  const clearLogs = useCallback(() => {
    if (activeVideoId) {
      setLogsByVideoId((prev) => {
        const next = { ...prev }
        delete next[activeVideoId]
        return next
      })
      knownBackendIds.current[activeVideoId] = new Set()
    } else {
      setLogs([])
    }
  }, [activeVideoId])

  const displayLogs = activeVideoId
    ? (logsByVideoId[activeVideoId] ?? [])
    : logs

  return (
    <LogsContext.Provider
      value={{
        logs: displayLogs,
        addLog,
        clearLogs,
        activeVideoId,
        setActiveVideoId,
        fetchLogsForVideo,
      }}
    >
      {children}
    </LogsContext.Provider>
  )
}

export function useLogs() {
  const ctx = useContext(LogsContext)
  if (!ctx) throw new Error("useLogs must be used within LogsProvider")
  return ctx
}
