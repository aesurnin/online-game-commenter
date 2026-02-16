import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useLogs } from "@/contexts/LogsContext"

type Project = { id: string; name: string }

export function Dashboard() {
  const [user, setUser] = useState<{ username?: string } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [newName, setNewName] = useState("")
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { addLog } = useLogs()

  async function fetchUser() {
    const r = await fetch("/api/auth/me", { credentials: "include" })
    if (!r.ok) throw new Error("Unauthorized")
    return r.json()
  }

  async function fetchProjects() {
    const r = await fetch("/api/projects", { credentials: "include" })
    if (!r.ok) return []
    return r.json()
  }

  useEffect(() => {
    addLog("Loading dashboard")
    fetchUser()
      .then((u) => {
        setUser(u)
        addLog(`User: ${u?.username || "unknown"}`)
        return fetchProjects()
      })
      .then((list) => {
        setProjects(list)
        addLog(`Loaded ${list.length} project(s)`)
      })
      .catch(() => {
        addLog("Unauthorized, redirecting to login", "warn")
        navigate("/login")
      })
  }, [navigate, addLog])

  async function handleLogout() {
    addLog("Signing out")
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    navigate("/login")
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault()
    if (!newName.trim()) return
    addLog(`Creating project: ${newName.trim()}`)
    setLoading(true)
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
        credentials: "include",
      })
      if (r.ok) {
        const p = await r.json()
        setProjects((prev) => [...prev, p])
        setNewName("")
        addLog(`Project created: ${p.name} (${p.id.slice(0, 8)}...)`)
      } else {
        addLog(`Create project failed: ${r.status}`, "error")
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: string) {
    addLog(`Deleting project ${id.slice(0, 8)}...`)
    const r = await fetch(`/api/projects/${id}`, {
      method: "DELETE",
      credentials: "include",
    })
    if (r.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== id))
      addLog("Project deleted")
    } else {
      addLog(`Delete project failed: ${r.status}`, "error")
    }
  }

  if (!user) return <div className="p-8">Loading...</div>

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-card">
        <div className="container mx-auto flex h-14 items-center justify-between px-4">
          <h1 className="font-semibold">Video Platform</h1>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {user.username || "User"}
            </span>
            <Button variant="outline" size="sm" onClick={handleLogout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main className="container mx-auto p-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Projects</CardTitle>
            <CardDescription>
              Create projects and add videos for processing
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleCreateProject} className="flex gap-2">
              <Input
                placeholder="Project name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button type="submit" disabled={loading}>
                Create
              </Button>
            </form>
            <div className="grid gap-2">
              {projects.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No projects yet. Create your first one.
                </p>
              ) : (
                projects.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <span className="font-medium">{p.name}</span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          addLog(`Opening project: ${p.name}`)
                          navigate(`/projects/${p.id}`)
                        }}
                      >
                        Open
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(p.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
