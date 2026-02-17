import { useState } from "react"
import { useLocation } from "react-router-dom"
import { PanelRightOpen, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { LogsPanel } from "@/components/LogsPanel"
import { WorkflowEditor } from "@/components/WorkflowEditor"
import { useTheme } from "@/contexts/ThemeContext"

export function RightPanel() {
  const location = useLocation()
  const [expanded, setExpanded] = useState(true)
  const { theme, toggleTheme } = useTheme()
  const isProjectPage = location.pathname.startsWith("/projects/")

  if (!expanded) {
    return (
      <div className="w-10 shrink-0 border-l bg-panel-1 flex flex-col items-center py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setExpanded(true)}
          title="Show panel"
        >
          <PanelRightOpen className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="w-96 shrink-0 border-l bg-panel-1 flex flex-col min-w-[280px] max-w-[50vw]">
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden min-w-0">
        {isProjectPage && (
          <div className="flex-1 min-h-[160px] flex flex-col border-b overflow-hidden">
            <WorkflowEditor />
          </div>
        )}
        <div className="flex-1 min-h-[120px] flex flex-col overflow-hidden">
          <LogsPanel embedded />
        </div>
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setExpanded(false)}
          title="Hide panel"
        >
          <PanelRightOpen className="h-4 w-4 rotate-180" />
        </Button>
      </div>
    </div>
  )
}
