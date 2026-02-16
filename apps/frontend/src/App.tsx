import { useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { Login } from "@/pages/Login"
import { Register } from "@/pages/Register"
import { Dashboard } from "@/pages/Dashboard"
import { ProjectView } from "@/pages/ProjectView"
import { LogsProvider, useLogs } from "@/contexts/LogsContext"
import { LogsPanel } from "@/components/LogsPanel"

function AppInit() {
  const { addLog } = useLogs()
  useEffect(() => {
    addLog("App started")
  }, [addLog])
  return null
}

function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <AppInit />
      <main className="flex-1 min-w-0 overflow-auto">
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/projects/:id" element={<ProjectView />} />
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
      <LogsPanel />
    </div>
  )
}

function App() {
  return (
    <LogsProvider>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </LogsProvider>
  )
}

export default App
