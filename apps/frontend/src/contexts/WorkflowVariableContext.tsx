import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

type WorkflowDef = { name: string; modules: unknown[] }
type ModuleMeta = { type: string; label: string; outputSlots?: Array<{ key: string; kind?: string }> }

type WorkflowVariableContextValue = {
  workflow: WorkflowDef | null
  moduleTypes: ModuleMeta[]
  setWorkflowData: (workflow: WorkflowDef | null, moduleTypes: ModuleMeta[]) => void
  variableManagerOpen: boolean
  openVariableManager: () => void
  closeVariableManager: () => void
}

const WorkflowVariableContext = createContext<WorkflowVariableContextValue | null>(null)

export function WorkflowVariableProvider({ children }: { children: ReactNode }) {
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null)
  const [moduleTypes, setModuleTypes] = useState<ModuleMeta[]>([])
  const [variableManagerOpen, setVariableManagerOpen] = useState(false)

  const setWorkflowData = useCallback((w: WorkflowDef | null, m: ModuleMeta[]) => {
    setWorkflow(w)
    setModuleTypes(m)
  }, [])

  const openVariableManager = useCallback(() => setVariableManagerOpen(true), [])
  const closeVariableManager = useCallback(() => setVariableManagerOpen(false), [])

  return (
    <WorkflowVariableContext.Provider
      value={{
        workflow,
        moduleTypes,
        setWorkflowData,
        variableManagerOpen,
        openVariableManager,
        closeVariableManager,
      }}
    >
      {children}
    </WorkflowVariableContext.Provider>
  )
}

export function useWorkflowVariable() {
  const ctx = useContext(WorkflowVariableContext)
  return ctx
}
