import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useParams, useLocation } from "react-router-dom"
import { X, Video, FileText, Database, Loader2, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"

export type WorkflowVariable = {
  name: string
  kind: "source" | "video" | "text"
  producedByStep: number | null
  producedByLabel: string
  usedBySteps: number[]
}

type ModuleMeta = {
  type: string
  label: string
  outputSlots?: Array<{ key: string; kind?: string }>
}

type WorkflowModuleDef = {
  id: string
  type: string
  inputs?: Record<string, string>
  outputs?: Record<string, string>
}

type WorkflowDef = {
  name: string
  modules: WorkflowModuleDef[]
}

interface VariableManagerModalProps {
  isOpen: boolean
  onClose: () => void
  workflow: WorkflowDef | null
  moduleTypes: ModuleMeta[]
}

function ValueWithTooltip({
  value,
  preview,
  children,
}: {
  value: string
  preview?: string
  children?: React.ReactNode
}) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLSpanElement>(null)

  const handleMouseEnter = () => {
    const rect = ref.current?.getBoundingClientRect()
    if (rect) {
      setPos({ x: rect.left, y: rect.top })
      setHover(true)
    }
  }
  const handleMouseLeave = () => setHover(false)

  return (
    <>
      <span
        ref={ref}
        className="flex items-center gap-1 min-w-0 cursor-help"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="truncate text-muted-foreground">
          {preview ?? (value.length > 40 ? value.slice(0, 40) + "…" : value)}
        </span>
        {children}
      </span>
      {hover &&
        createPortal(
          <div
            className="fixed z-[9999] bg-background border border-border rounded-md shadow-lg px-2 py-1.5 text-xs font-mono max-w-[320px] break-all whitespace-pre-wrap text-foreground pointer-events-none"
            style={{ left: pos.x, top: pos.y - 8, transform: "translateY(-100%)" }}
          >
            {value}
          </div>,
          document.body
        )}
    </>
  )
}

function extractVariables(
  workflow: WorkflowDef,
  moduleTypes: ModuleMeta[]
): WorkflowVariable[] {
  const vars: WorkflowVariable[] = []
  const usedBy: Record<string, number[]> = {}

  // source is always present
  vars.push({
    name: "source",
    kind: "source",
    producedByStep: null,
    producedByLabel: "Initial video",
    usedBySteps: [],
  })

  for (let i = 0; i < workflow.modules.length; i++) {
    const mod = workflow.modules[i]
    const meta = moduleTypes.find((m) => m.type === mod.type)

    if (mod.outputs) {
      for (const [slotKey, varName] of Object.entries(mod.outputs)) {
        if (!varName) continue
        const slot = meta?.outputSlots?.find((s) => s.key === slotKey)
        const kind = slot?.kind === "text" ? "text" : "video"
        vars.push({
          name: varName,
          kind,
          producedByStep: i,
          producedByLabel: meta ? `${meta.label} (Step ${i + 1})` : `Step ${i + 1}`,
          usedBySteps: [],
        })
      }
    }

    if (mod.inputs) {
      for (const varName of Object.values(mod.inputs)) {
        if (!varName) continue
        if (!usedBy[varName]) usedBy[varName] = []
        usedBy[varName].push(i)
      }
    }
  }

  for (const v of vars) {
    v.usedBySteps = usedBy[v.name] ?? []
  }

  return vars
}

export function VariableManagerModal({
  isOpen,
  onClose,
  workflow,
  moduleTypes,
}: VariableManagerModalProps) {
  const { id: projectIdFromParams } = useParams<{ id: string }>()
  const location = useLocation()
  const projectIdFromPath = location.pathname.match(/^\/projects\/([^/]+)/)?.[1]
  const projectId = projectIdFromParams ?? projectIdFromPath ?? null
  const { selectedVideo } = useSelectedVideo()
  const videoId = selectedVideo?.videoId ?? null
  const [values, setValues] = useState<Record<string, { value: string; preview?: string; url?: string }>>({})
  const [loading, setLoading] = useState(false)

  const workflowKey = workflow
    ? `${workflow.name}-${workflow.modules?.map((m: { id?: string; outputs?: Record<string, string> }) => `${m.id}:${JSON.stringify(m.outputs ?? {})}`).join("|") ?? ""}`
    : ""

  useEffect(() => {
    if (!isOpen || !workflow || !projectId || !videoId) {
      setValues({})
      return
    }
    let cancelled = false
    setLoading(true)
    fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-variables`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ workflow }),
    })
      .then((r) => (r.ok ? r.json() : { variables: {} }))
      .then((data) => {
        if (!cancelled) setValues(data.variables ?? {})
      })
      .catch(() => {
        if (!cancelled) setValues({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [isOpen, workflowKey, projectId, videoId])

  if (!isOpen) return null

  const variables = workflow ? extractVariables(workflow, moduleTypes) : []

  const KindIcon = ({ kind }: { kind: WorkflowVariable["kind"] }) => {
    if (kind === "source") return <Database className="h-3.5 w-3.5 text-muted-foreground" />
    if (kind === "video") return <Video className="h-3.5 w-3.5 text-blue-500" />
    return <FileText className="h-3.5 w-3.5 text-amber-500" />
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">Variable Manager</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Workflow variables for the current video. Variables are produced by module outputs and consumed by downstream inputs.
          </p>

          {!workflow ? (
            <p className="text-sm text-muted-foreground py-4">Select a workflow and video to see variables.</p>
          ) : !projectId || !videoId ? (
            <p className="text-sm text-muted-foreground py-4">Select a video in the project to see variable values.</p>
          ) : variables.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No variables yet. Add modules to the workflow.</p>
          ) : (
            <div className="rounded border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 border-b">
                    <th className="text-left px-3 py-2 font-medium">Variable</th>
                    <th className="text-left px-3 py-2 font-medium">Kind</th>
                    <th className="text-left px-3 py-2 font-medium">Value</th>
                    <th className="text-left px-3 py-2 font-medium">Produced by</th>
                    <th className="text-left px-3 py-2 font-medium">Used by</th>
                  </tr>
                </thead>
                <tbody>
                  {variables.map((v) => {
                    const val = values[v.name]
                    return (
                      <tr key={v.name} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-2 font-mono">
                          <span className="inline-flex items-center rounded px-1.5 py-0.5 bg-primary/10 text-primary border border-primary/20">
                            ({v.name})
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1">
                            <KindIcon kind={v.kind} />
                            {v.kind}
                          </span>
                        </td>
                        <td className="px-3 py-2 max-w-[200px] overflow-visible">
                          {loading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          ) : val ? (
                            <ValueWithTooltip value={val.value} preview={val.preview}>
                              {val.url && (
                                <a
                                  href={val.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="shrink-0 text-primary hover:underline"
                                  title="Open"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </ValueWithTooltip>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {v.producedByLabel}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {v.usedBySteps.length === 0
                            ? "—"
                            : v.usedBySteps.map((s) => `Step ${s + 1}`).join(", ")}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
