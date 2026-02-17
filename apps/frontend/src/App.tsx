import { useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom"
import { Login } from "@/pages/Login"
import { Dashboard } from "@/pages/Dashboard"
import { ProjectView } from "@/pages/ProjectView"
import { QueueMonitor } from "@/pages/QueueMonitor"
import { Providers } from "@/pages/Providers"
import { LogsProvider, useLogs } from "@/contexts/LogsContext"
import { SelectedVideoProvider } from "@/contexts/SelectedVideoContext"
import { PreviewVideoProvider } from "@/contexts/PreviewVideoContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { RightPanel } from "@/components/RightPanel"

function AppInit() {
  const { addLog } = useLogs()
  useEffect(() => {
    addLog("App started")
  }, [addLog])
  return null
}

function AppLayout() {
  const location = useLocation()
  const showLogsPanel = location.pathname !== "/login"

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
      {showLogsPanel && <RightPanel />}
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
