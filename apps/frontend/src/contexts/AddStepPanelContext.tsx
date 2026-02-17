import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

type OnSelectModule = (type: string) => void

const AddStepPanelContext = createContext<{
  addStepPanelOpen: boolean
  openAddStepPanel: () => void
  closeAddStepPanel: () => void
  onSelectModule: OnSelectModule | null
  setOnSelectModule: (cb: OnSelectModule | null) => void
} | null>(null)

export function AddStepPanelProvider({ children }: { children: ReactNode }) {
  const [addStepPanelOpen, setAddStepPanelOpen] = useState(false)
  const [onSelectModule, setOnSelectModuleState] = useState<OnSelectModule | null>(null)

  const openAddStepPanel = useCallback(() => setAddStepPanelOpen(true), [])
  const closeAddStepPanel = useCallback(() => setAddStepPanelOpen(false), [])
  const setOnSelectModule = useCallback((cb: OnSelectModule | null) => setOnSelectModuleState(() => cb), [])

  return (
    <AddStepPanelContext.Provider
      value={{
        addStepPanelOpen,
        openAddStepPanel,
        closeAddStepPanel,
        onSelectModule,
        setOnSelectModule,
      }}
    >
      {children}
    </AddStepPanelContext.Provider>
  )
}

export function useAddStepPanel() {
  const ctx = useContext(AddStepPanelContext)
  if (!ctx) throw new Error("useAddStepPanel must be used within AddStepPanelProvider")
  return ctx
}
