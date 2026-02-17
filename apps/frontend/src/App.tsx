import { useEffect, useState } from "react"
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate, useParams } from "react-router-dom"
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { Video, FolderOpen, GitBranch, FileText, Moon, Sun, Pencil } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Login } from "@/pages/Login"
import { Dashboard } from "@/pages/Dashboard"
import { ProjectView } from "@/pages/ProjectView"
import { QueueMonitor } from "@/pages/QueueMonitor"
import { Providers } from "@/pages/Providers"
import { LogsProvider, useLogs } from "@/contexts/LogsContext"
import { SelectedVideoProvider } from "@/contexts/SelectedVideoContext"
import { PreviewVideoProvider } from "@/contexts/PreviewVideoContext"
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext"
import { ActivityBar } from "@/components/ActivityBar"
import { RightPanel } from "@/components/RightPanel"

const LAYOUT_STORAGE_KEY = "app-layout-main-right"
const PANELS_VISIBLE_KEY = "app-panels-visible"

function AppInit() {
  const { addLog } = useLogs()
  useEffect(() => {
    addLog("App started")
  }, [addLog])
  return null
}

function AppHeader() {
  const location = useLocation()
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const { addLog } = useLogs()
  const { id: projectId } = useParams<{ id: string }>()
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [editingProjectName, setEditingProjectName] = useState(false)

  const isProjectPage = location.pathname.startsWith("/projects/")

  useEffect(() => {
    if (!projectId) return
    fetch(`/api/projects/${projectId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setProject(data))
      .catch(() => setProject(null))
  }, [projectId])

  async function handleRenameProject(newName: string) {
    if (!project || !newName.trim()) {
      setEditingProjectName(false)
      return
    }
    const r = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
      credentials: "include",
    })
    if (r.ok) {
      setProject({ ...project, name: newName.trim() })
    }
    setEditingProjectName(false)
  }

  if (location.pathname === "/login") return null

  return (
    <header className="border-b bg-panel-1 shrink-0">
      <div className="flex h-10 items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              addLog("Navigating to dashboard")
              navigate("/dashboard")
            }}
          >
            ← Dashboard
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/queue")}>
            Queue
          </Button>
          <Button variant="ghost" size="sm" onClick={() => navigate("/providers")}>
            Providers
          </Button>
          {isProjectPage && project && (
            <>
              {editingProjectName ? (
                <Input
                  className="h-7 w-48 text-sm font-semibold"
                  defaultValue={project.name}
                  autoFocus
                  onBlur={(e) => handleRenameProject(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameProject((e.target as HTMLInputElement).value)
                    if (e.key === "Escape") setEditingProjectName(false)
                  }}
                />
              ) : (
                <h1
                  className="text-sm font-semibold cursor-pointer hover:bg-muted/50 rounded px-2 py-1 flex items-center gap-1"
                  onClick={() => setEditingProjectName(true)}
                >
                  {project.name}
                  <Pencil className="h-3 w-3 text-muted-foreground" />
                </h1>
              )}
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </header>
  )
}

function AppLayout() {
  const location = useLocation()
  const showLogsPanel = location.pathname !== "/login"
  const rightPanelRef = usePanelRef()
  const isProjectPage = location.pathname.startsWith("/projects/")

  const [videosVisible, setVideosVisible] = useState(() => {
    try {
      const s = localStorage.getItem(PANELS_VISIBLE_KEY)
      if (s) {
        const p = JSON.parse(s) as { videos?: boolean }
        return p.videos !== false
      }
    } catch {}
    return true
  })

  const [assetsVisible, setAssetsVisible] = useState(() => {
    try {
      const s = localStorage.getItem(PANELS_VISIBLE_KEY)
      if (s) {
        const p = JSON.parse(s) as { assets?: boolean }
        return p.assets !== false
      }
    } catch {}
    return true
  })

  const [workflowVisible, setWorkflowVisible] = useState(() => {
    try {
      const s = localStorage.getItem(PANELS_VISIBLE_KEY)
      if (s) {
        const p = JSON.parse(s) as { workflow?: boolean }
        return p.workflow !== false
      }
    } catch {}
    return true
  })

  const [logsVisible, setLogsVisible] = useState(() => {
    try {
      const s = localStorage.getItem(PANELS_VISIBLE_KEY)
      if (s) {
        const p = JSON.parse(s) as { logs?: boolean }
        return p.logs !== false
      }
    } catch {}
    return true
  })

  useEffect(() => {
    localStorage.setItem(
      PANELS_VISIBLE_KEY,
      JSON.stringify({ videos: videosVisible, assets: assetsVisible, workflow: workflowVisible, logs: logsVisible })
    )
  }, [videosVisible, assetsVisible, workflowVisible, logsVisible])

  const defaultLayout = (): { main: number; right: number } => {
    try {
      const s = localStorage.getItem(LAYOUT_STORAGE_KEY)
      if (s) {
        const parsed = JSON.parse(s) as { main?: number; right?: number }
        if (
          typeof parsed.main === "number" &&
          typeof parsed.right === "number" &&
          parsed.main >= 20 &&
          parsed.main <= 90 &&
          parsed.right >= 10 &&
          parsed.right <= 80
        ) {
          return { main: parsed.main, right: parsed.right }
        }
      }
    } catch {
      /* ignore */
    }
    return { main: 75, right: 25 }
  }

  const layout = defaultLayout()

  if (!showLogsPanel) {
    return (
      <div className="flex h-screen overflow-hidden">
        <AppInit />
        <main className="flex-1 min-w-0 overflow-auto">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/projects/:id" element={<ProjectView />} />
            <Route path="/queue" element={<QueueMonitor />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    )
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col">
      <AppInit />
      <AppHeader />
      <div className="flex-1 flex min-h-0">
        <ActivityBar
        orientation="vertical"
        items={[
          ...(isProjectPage
            ? [
                {
                  id: "videos",
                  icon: Video,
                  label: "Videos",
                  active: videosVisible,
                  onClick: () => setVideosVisible((v) => !v),
                },
                {
                  id: "assets",
                  icon: FolderOpen,
                  label: "Assets",
                  active: assetsVisible,
                  onClick: () => setAssetsVisible((v) => !v),
                },
              ]
            : []),
          ...(isProjectPage
            ? [
                {
                  id: "workflow",
                  icon: GitBranch,
                  label: "Workflow",
                  active: workflowVisible,
                  onClick: () => setWorkflowVisible((v) => !v),
                },
              ]
            : []),
          {
            id: "logs",
            icon: FileText,
            label: "Logs",
            active: logsVisible,
            onClick: () => setLogsVisible((v) => !v),
          },
        ]}
      />
      <Group
        id="app-main-right"
        orientation="horizontal"
        className="flex-1"
        defaultLayout={{ main: layout.main, right: layout.right }}
        resizeTargetMinimumSize={{ coarse: 24, fine: 6 }}
        onLayoutChanged={(l) => {
          if (typeof l.main === "number" && typeof l.right === "number") {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ main: l.main, right: l.right }))
          }
        }}
      >
        <Panel id="main" defaultSize={`${layout.main}%`} minSize="20%" className="min-w-0">
          <main className="h-full overflow-auto">
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route
                path="/projects/:id"
                element={
                  <ProjectView
                    videosVisible={videosVisible}
                    assetsVisible={assetsVisible}
                  />
                }
              />
              <Route path="/queue" element={<QueueMonitor />} />
              <Route path="/providers" element={<Providers />} />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </Panel>
        <Separator className="shrink-0" />
        <Panel
          id="right"
          panelRef={rightPanelRef}
          defaultSize={`${layout.right}%`}
          minSize="15%"
          maxSize="60%"
          collapsible
          collapsedSize={40}
          className="min-w-0 flex flex-col"
        >
          <RightPanel panelRef={rightPanelRef} workflowVisible={workflowVisible} logsVisible={logsVisible} />
        </Panel>
      </Group>
      </div>
    </div>
  )
}

function App() {
  return (
    <ThemeProvider>
      <LogsProvider>
        <SelectedVideoProvider>
          <PreviewVideoProvider>
            <BrowserRouter>
              <AppLayout />
            </BrowserRouter>
          </PreviewVideoProvider>
        </SelectedVideoProvider>
      </LogsProvider>
    </ThemeProvider>
  )
}

export default App
