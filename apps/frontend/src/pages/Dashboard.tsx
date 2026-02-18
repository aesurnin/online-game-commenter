import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLogs } from "@/contexts/LogsContext"
import { useTheme } from "@/contexts/ThemeContext"
import { ShaderBackground } from "@/components/ShaderBackground"
import { Pencil, FolderOpen, Trash2, Loader2, Moon, Sun } from "lucide-react"

type Project = { id: string; name: string }

type ProjectDetail = {
  id: string
  name: string
  ownerId: string
  createdAt?: string
  updatedAt?: string
  videoCount: number
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    })
  } catch {
    return iso
  }
}

export function Dashboard() {
  const [user, setUser] = useState<{ username?: string } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedDetail, setSelectedDetail] = useState<ProjectDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState("")
  const [newName, setNewName] = useState("")
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { addLog } = useLogs()
  const { theme, toggleTheme } = useTheme()

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

  async function fetchProjectDetail(id: string) {
    const r = await fetch(`/api/projects/${id}`, { credentials: "include" })
    if (!r.ok) return null
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

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null)
      setDetailLoading(false)
      return
    }
    setDetailLoading(true)
    fetchProjectDetail(selectedId).then((detail) => {
      setSelectedDetail(detail)
      setEditNameValue(detail?.name ?? "")
      setDetailLoading(false)
    })
  }, [selectedId])

  async function handleRenameProject(newName: string) {
    if (!selectedId || !newName.trim()) {
      setEditingName(false)
      return
    }
    const r = await fetch(`/api/projects/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name: newName.trim() }),
    })
    if (r.ok) {
      setProjects((prev) =>
        prev.map((p) => (p.id === selectedId ? { ...p, name: newName.trim() } : p))
      )
      setSelectedDetail((prev) =>
        prev ? { ...prev, name: newName.trim() } : null
      )
      setEditNameValue(newName.trim())
      addLog(`Project renamed to ${newName.trim()}`)
    }
    setEditingName(false)
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
        setSelectedId(p.id)
        addLog(`Project created: ${p.name} (${p.id.slice(0, 8)}...)`)
      } else {
        addLog(`Create project failed: ${r.status}`, "error")
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleLogout() {
    addLog("Signing out")
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    navigate("/login")
  }

  async function handleDelete(id: string) {
    addLog(`Deleting project ${id.slice(0, 8)}...`)
    const r = await fetch(`/api/projects/${id}`, {
      method: "DELETE",
      credentials: "include",
    })
    if (r.ok) {
      setProjects((prev) => prev.filter((p) => p.id !== id))
      if (selectedId === id) {
        setSelectedId(null)
        setSelectedDetail(null)
      }
      addLog("Project deleted")
    } else {
      addLog(`Delete project failed: ${r.status}`, "error")
    }
  }

  if (!user) return <div className="p-8">Loading...</div>

  return (
    <div className="flex flex-col flex-1 min-h-0 relative overflow-hidden">
      <ShaderBackground dark={theme === "dark"} className="z-0" />
      {/* Top bar: nav + user */}
      <header className="shrink-0 h-11 border-b bg-panel-1/80 backdrop-blur-sm flex items-center justify-between px-4 relative z-10">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate("/queue")}>
            Queue
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/providers")}>
            Providers
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <span className="text-sm text-muted-foreground">{user.username || "User"}</span>
          <Button variant="outline" size="sm" onClick={handleLogout}>
            Sign out
          </Button>
        </div>
      </header>
      {/* Centered main content */}
      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6 relative z-10">
        <div className="w-full max-w-4xl min-h-[480px] rounded-xl border bg-card/95 backdrop-blur-md shadow-xl overflow-hidden flex flex-col sm:flex-row">
          {/* Left: project list */}
          <div className="w-full sm:w-72 shrink-0 border-b sm:border-b-0 sm:border-r bg-muted/30 flex flex-col">
            <div className="p-4 border-b shrink-0">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Projects
              </h2>
              <form onSubmit={handleCreateProject} className="flex gap-2">
                <Input
                  placeholder="New project name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="h-9 text-sm bg-background"
                />
                <Button type="submit" disabled={loading} size="sm" variant="outline">
                  Create
                </Button>
              </form>
            </div>
            <div
              className="flex-1 overflow-y-auto p-2 min-h-[200px]"
              onClick={(e) => {
                if (selectedId && !(e.target as HTMLElement).closest("button")) {
                  setSelectedId(null)
                }
              }}
            >
              {projects.length === 0 ? (
                <p className="text-muted-foreground text-sm py-6 px-3 text-center">
                  No projects yet. Create your first one above.
                </p>
              ) : (
                <div className="space-y-1">
                  {projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedId(p.id)}
                      className={`w-full text-left rounded-lg px-3 py-2.5 transition-all duration-150 ${
                        selectedId === p.id
                          ? "bg-sky-500/10 dark:bg-primary/15 border border-sky-300/50 dark:border-primary/30 text-foreground"
                          : "hover:bg-muted/80 text-foreground border border-transparent"
                      }`}
                    >
                      <span className="font-medium text-sm truncate block">
                        {p.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* Right: metadata panel */}
          <div className="flex-1 min-w-0 flex flex-col bg-background/50 min-h-[320px]">
            {detailLoading ? (
              <div className="flex flex-col items-center justify-center flex-1 p-8 text-center text-muted-foreground">
                <Loader2 className="h-10 w-10 mb-4 animate-spin opacity-70" />
                <p className="text-sm">Loading project details…</p>
              </div>
            ) : !selectedDetail ? (
              <div className="flex flex-col items-center justify-center flex-1 p-8 text-center text-muted-foreground">
                <FolderOpen className="h-14 w-14 mb-5 opacity-40" />
                <p className="text-sm font-medium">
                  {projects.length === 0
                    ? "Create a project to get started"
                    : "Select a project to view details"}
                </p>
                <p className="text-xs mt-1 opacity-80">
                  {projects.length > 0 && "Click a project from the list"}
                </p>
              </div>
            ) : (
              <div className="flex flex-col flex-1 p-6 overflow-auto">
                <div className="flex items-center gap-2 mb-6">
                  {editingName ? (
                    <Input
                      className="text-lg font-semibold h-9 flex-1"
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onBlur={() => handleRenameProject(editNameValue)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleRenameProject(editNameValue)
                        if (e.key === "Escape") {
                          setEditNameValue(selectedDetail.name)
                          setEditingName(false)
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <>
                      <h3 className="text-lg font-semibold truncate flex-1">
                        {selectedDetail.name}
                      </h3>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          setEditingName(true)
                          setEditNameValue(selectedDetail.name)
                        }}
                        title="Edit name"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
                <div className="space-y-4 text-sm">
                  <div className="flex justify-between gap-4 py-3 px-4 rounded-lg bg-muted/40">
                    <span className="text-muted-foreground">ID</span>
                    <code className="text-xs font-mono truncate max-w-[220px]" title={selectedDetail.id}>
                      {selectedDetail.id}
                    </code>
                  </div>
                  <div className="flex justify-between gap-4 py-3 px-4 rounded-lg bg-muted/40">
                    <span className="text-muted-foreground">Videos</span>
                    <span className="font-medium">{selectedDetail.videoCount}</span>
                  </div>
                  <div className="flex justify-between gap-4 py-3 px-4 rounded-lg bg-muted/40">
                    <span className="text-muted-foreground">Created</span>
                    <span>{formatDate(selectedDetail.createdAt)}</span>
                  </div>
                  <div className="flex justify-between gap-4 py-3 px-4 rounded-lg bg-muted/40">
                    <span className="text-muted-foreground">Updated</span>
                    <span>{formatDate(selectedDetail.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex gap-2 mt-6 pt-4 border-t">
                  <Button
                    variant="outline"
                    onClick={() => {
                      addLog(`Opening project: ${selectedDetail.name}`)
                      navigate(`/projects/${selectedDetail.id}`)
                    }}
                    className="gap-2"
                  >
                    <FolderOpen className="h-4 w-4" />
                    Open project
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => handleDelete(selectedDetail.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
