import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useLogs } from "@/contexts/LogsContext"
import { Activity, Clock, XCircle, CheckCircle, Loader2, RefreshCw, Trash2 } from "lucide-react"

type JobItem = {
  id: string
  type: "screencast" | "workflow"
  projectId?: string
  projectName?: string
  videoId?: string
  status: string
  taskLabel?: string
  url?: string
  failedReason?: string
  progress?: number
  message?: string
}

type QueueStatus = {
  counts: {
    waiting: number
    active: number
    failed: number
    completed: number
    delayed: number
  }
  waiting: JobItem[]
  active: JobItem[]
  failed: JobItem[]
  completed: JobItem[]
  strategy: string
}

export function QueueMonitor() {
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [killing, setKilling] = useState<string | null>(null)
  const navigate = useNavigate()
  const { addLog } = useLogs()

  async function killJob(jobId: string) {
    setKilling(jobId)
    try {
      const r = await fetch(`/api/queue/jobs/${jobId}/kill`, {
        method: "POST",
        credentials: "include",
      })
      if (r.ok) fetchStatus()
      else addLog(`Kill failed: ${r.status}`, "error")
    } catch (e) {
      addLog(`Kill failed: ${e}`, "error")
    } finally {
      setKilling(null)
    }
  }

  async function fetchStatus() {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch("/api/queue/status", { credentials: "include" })
      if (!r.ok) {
        if (r.status === 401) {
          navigate("/login")
          return
        }
        throw new Error(`HTTP ${r.status}`)
      }
      const data = await r.json()
      setStatus(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load")
      addLog(`Queue status error: ${e}`, "error")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 3000)
    return () => clearInterval(interval)
  }, [navigate])

  if (loading && !status) {
    return (
      <div className="min-h-screen bg-panel-0 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-panel-0">
      <header className="border-b bg-panel-1">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <h1 className="font-semibold">Queue Monitor</h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/dashboard")}>
              Dashboard
            </Button>
            <Button variant="ghost" size="icon" onClick={fetchStatus} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </header>
      <main className="container mx-auto p-6 space-y-6">
        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
            {error}
          </div>
        )}
        {status && (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Strategy</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{status.strategy}</p>
                  <p className="text-xs text-muted-foreground">Recording mode</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Waiting</CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{status.counts.waiting}</p>
                  <p className="text-xs text-muted-foreground">In queue</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Active</CardTitle>
                  <Activity className="h-4 w-4 text-primary" />
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{status.counts.active}</p>
                  <p className="text-xs text-muted-foreground">Processing</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Failed</CardTitle>
                  <XCircle className="h-4 w-4 text-destructive" />
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{status.counts.failed}</p>
                  <p className="text-xs text-muted-foreground">Errors</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">Completed</CardTitle>
                  <CheckCircle className="h-4 w-4 text-green-600" />
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{status.counts.completed}</p>
                  <p className="text-xs text-muted-foreground">Done</p>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Active Jobs</CardTitle>
                  <CardDescription className="text-xs">Currently processing</CardDescription>
                </CardHeader>
                <CardContent>
                  {status.active.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-2">
                      {status.active.map((j) => (
                        <li key={j.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-0">
                          <Activity className="h-3.5 w-3.5 shrink-0 text-primary animate-pulse mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{j.taskLabel ?? j.type}</p>
                            <p className="text-muted-foreground truncate">
                              {j.projectName && <span>{j.projectName} · </span>}
                              {j.videoId?.slice(0, 8) ?? "—"}
                              {j.url && <span> · {j.url}</span>}
                            </p>
                            {j.type === "workflow" && j.progress != null && (
                              <p className="text-muted-foreground mt-0.5">{j.progress}% {j.message && `· ${j.message}`}</p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                            onClick={() => killJob(j.id)}
                            disabled={killing === j.id}
                            title="Cancel"
                          >
                            {killing === j.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Waiting</CardTitle>
                  <CardDescription className="text-xs">Queued for processing</CardDescription>
                </CardHeader>
                <CardContent>
                  {status.waiting.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-2">
                      {status.waiting.map((j) => (
                        <li key={j.id} className="flex items-start gap-2 text-xs py-1.5 border-b last:border-0">
                          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{j.taskLabel ?? j.type}</p>
                            <p className="text-muted-foreground truncate">
                              {j.projectName && <span>{j.projectName} · </span>}
                              {j.videoId?.slice(0, 8) ?? "—"}
                              {j.url && <span> · {j.url}</span>}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                            onClick={() => killJob(j.id)}
                            disabled={killing === j.id}
                            title="Cancel"
                          >
                            {killing === j.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Failed</CardTitle>
                  <CardDescription className="text-xs">Last 50 failed jobs</CardDescription>
                </CardHeader>
                <CardContent>
                  {status.failed.length === 0 ? (
                    <p className="text-xs text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-2 max-h-64 overflow-y-auto">
                      {status.failed.map((j) => (
                        <li key={j.id} className="text-xs border-b py-1.5 last:border-0">
                          <p className="font-medium truncate">{j.taskLabel ?? j.type}</p>
                          <p className="text-muted-foreground truncate">
                            {j.projectName && <span>{j.projectName} · </span>}
                            {j.videoId?.slice(0, 8) ?? "—"}
                            {j.url && <span> · {j.url}</span>}
                          </p>
                          {j.failedReason && (
                            <p className="text-destructive mt-0.5">{j.failedReason}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
            {status.completed.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Recently Completed</CardTitle>
                  <CardDescription className="text-xs">Last completed jobs</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2 max-h-48 overflow-y-auto">
                    {status.completed.map((j) => (
                      <li key={j.id} className="text-xs border-b py-1.5 last:border-0">
                        <p className="font-medium truncate">{j.taskLabel ?? j.type}</p>
                        <p className="text-muted-foreground truncate">
                          {j.projectName && <span>{j.projectName} · </span>}
                          {j.videoId?.slice(0, 8) ?? "—"}
                        </p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </main>
    </div>
  )
}
