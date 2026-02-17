import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { X, Loader2 } from "lucide-react"
import { useAddStepPanel } from "@/contexts/AddStepPanelContext"

type ModuleMeta = {
  type: string
  label: string
  description?: string
  category?: string
  paramsSchema?: unknown[]
  quickParams?: string[]
  inputSlots?: { key: string; label: string; kind: string }[]
  outputSlots?: { key: string; label: string; kind: string }[]
}

function getCategory(meta: ModuleMeta): string {
  if (meta.category) return meta.category
  const first = meta.type.split(".")[0]
  if (first) return first.charAt(0).toUpperCase() + first.slice(1)
  return "Other"
}

export function ModulePickerPanel() {
  const { closeAddStepPanel, onSelectModule } = useAddStepPanel()
  const [modules, setModules] = useState<ModuleMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch("/api/workflows/modules/list", { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((list) => {
        setModules(Array.isArray(list) ? list : [])
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to load modules")
        setModules([])
      })
      .finally(() => setLoading(false))
  }, [])

  const byCategory = modules.reduce<Record<string, ModuleMeta[]>>((acc, m) => {
    const cat = getCategory(m)
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(m)
    return acc
  }, {})
  const categoryOrder = ["Video", "LLM", "AI", "Other"]
  const sortedCategories = Object.keys(byCategory).sort(
    (a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b) || a.localeCompare(b)
  )

  const handleSelect = (type: string) => {
    onSelectModule?.(type)
  }

  return (
    <div className="h-full flex flex-col bg-panel-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="font-semibold text-lg">Add step</h2>
        <Button variant="ghost" size="icon" onClick={closeAddStepPanel} title="Close">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin mr-2" />
            Loading modules…
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-destructive mb-2">{error}</p>
            <Button variant="outline" size="sm" onClick={closeAddStepPanel}>
              Close
            </Button>
          </div>
        ) : (
          <div className="space-y-8 max-w-2xl mx-auto">
            {sortedCategories.map((cat) => (
              <section key={cat}>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                  {cat}
                </h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {byCategory[cat].map((m) => (
                    <button
                      key={m.type}
                      type="button"
                      className="text-left rounded-lg border border-border bg-background p-4 hover:bg-accent hover:border-accent-foreground/20 transition-colors"
                      onClick={() => handleSelect(m.type)}
                    >
                      <span className="font-medium block">{m.label}</span>
                      {m.description && (
                        <span className="text-xs text-muted-foreground mt-1 line-clamp-2 block">
                          {m.description}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
