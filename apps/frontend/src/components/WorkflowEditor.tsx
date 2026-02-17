import { useState, useEffect, useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CropModal } from "@/components/CropModal"
import { PromptBuilderModal } from "@/components/PromptBuilderModal"
import {
  Plus,
  Trash2,
  Play,
  ChevronUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Check,
  XCircle,
  FileDown,
  FileUp,
  Save,
  Eye,
  Crop as CropIcon,
  Pencil,
} from "lucide-react"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"
import { useLogs } from "@/contexts/LogsContext"
import { usePreviewVideo } from "@/contexts/PreviewVideoContext"
import { useAddStepPanel } from "@/contexts/AddStepPanelContext"

type WorkflowModuleDef = {
  id: string
  type: string
  params?: Record<string, unknown>
  outputs?: Record<string, string>
  inputs?: Record<string, string>
}

type WorkflowDefinition = {
  id?: string
  name: string
  modules: WorkflowModuleDef[]
}

type ModuleSlotDef = { key: string; label: string; kind: string }

type ModuleMeta = {
  type: string
  label: string
  description?: string
  quickParams?: string[]
  inputSlots?: ModuleSlotDef[]
  outputSlots?: ModuleSlotDef[]
  paramsSchema?: Array<{
    key: string
    label: string
    type: string
    default?: unknown
    min?: number
    max?: number
    options?: { value: string; label: string }[]
  }>
}

type StepStatus = "pending" | "running" | "done" | "error"

type VideoWorkflowState = {
  currentWorkflowId: string | null
  workflow: WorkflowDefinition | null
  stepStatuses: Record<number, StepStatus>
  stepOutputUrls: Record<number, string>
  stepOutputContentTypes: Record<number, string>
  activeJobId: string | null
  activeJobStepIndex: number | undefined
  jobProgress: number
  jobMessage: string
  jobLogs: string[]
  runningAll: boolean
}

const defaultVideoState = (): VideoWorkflowState => ({
  currentWorkflowId: null,
  workflow: null,
  stepStatuses: {},
  stepOutputUrls: {},
  stepOutputContentTypes: {},
  activeJobId: null,
  activeJobStepIndex: undefined,
  jobProgress: 0,
  jobMessage: "",
  jobLogs: [],
  runningAll: false,
})

const CACHE_KEY_PREFIX = "workflow-cache"
const MAX_CACHED_LOGS = 500
const AUTOSAVE_KEY = "workflow-editor-autosave"
const AUTOSAVE_DEBOUNCE_MS = 2000

function getCacheKey(projectId: string, videoId: string) {
  return `${CACHE_KEY_PREFIX}:${projectId}:${videoId}`
}

function loadFromCache(projectId: string, videoId: string): Partial<VideoWorkflowState> | null {
  try {
    const raw = localStorage.getItem(getCacheKey(projectId, videoId))
    if (!raw) return null
    return JSON.parse(raw) as Partial<VideoWorkflowState>
  } catch {
    return null
  }
}

function saveToCache(projectId: string, videoId: string, state: VideoWorkflowState) {
  try {
    const toSave = {
      currentWorkflowId: state.currentWorkflowId,
      workflow: state.workflow,
      stepStatuses: state.stepStatuses,
      stepOutputUrls: state.stepOutputUrls,
      stepOutputContentTypes: state.stepOutputContentTypes,
      jobLogs: state.jobLogs.slice(-MAX_CACHED_LOGS),
    }
    localStorage.setItem(getCacheKey(projectId, videoId), JSON.stringify(toSave))
  } catch {
    // ignore
  }
}

function generateId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

export function WorkflowEditor() {
  const { selectedVideo, refreshAssets } = useSelectedVideo()
  const { addLog } = useLogs()
  const { setPreviewVideo } = usePreviewVideo()
  const { openAddStepPanel, closeAddStepPanel, setOnSelectModule } = useAddStepPanel()
  const [workflows, setWorkflows] = useState<{ id: string; name?: string }[]>([])
  const [stateByVideo, setStateByVideo] = useState<Record<string, VideoWorkflowState>>({})
  const [moduleTypes, setModuleTypes] = useState<ModuleMeta[]>([])
  const [saving, setSaving] = useState(false)
  const [newWorkflowName, setNewWorkflowName] = useState("")
  const [expandedModuleIndex, setExpandedModuleIndex] = useState<number | null>(null)
  const [cropModalOpen, setCropModalOpen] = useState(false)
  const [cropModuleIndex, setCropModuleIndex] = useState<number | null>(null)
  const [openPromptBuilder, setOpenPromptBuilder] = useState<{ index: number; paramKey: string } | null>(null)
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem(AUTOSAVE_KEY) !== "false"
    } catch {
      return true
    }
  })

  const projectId = selectedVideo?.projectId
  const videoId = selectedVideo?.videoId

  const videoState = videoId ? (stateByVideo[videoId] ?? defaultVideoState()) : defaultVideoState()
  const {
    currentWorkflowId,
    workflow,
    stepStatuses,
    stepOutputUrls,
    stepOutputContentTypes,
    activeJobId,
    jobProgress,
    jobMessage,
    jobLogs,
    runningAll,
  } = videoState

  const isJobForCurrentVideo = activeJobId && videoId
  const showProgress = isJobForCurrentVideo
  const activeJobVideoIdRef = useRef<string | null>(null)
  const addModuleRef = useRef<(type: string) => void>(() => {})

  const updateVideoState = useCallback((vid: string, updates: Partial<VideoWorkflowState>) => {
    setStateByVideo((prev) => ({
      ...prev,
      [vid]: { ...(prev[vid] ?? defaultVideoState()), ...updates },
    }))
  }, [])

  const fetchWorkflows = useCallback(async () => {
    try {
      const r = await fetch("/api/workflows", { credentials: "include" })
      if (r.ok) {
        const list = await r.json()
        setWorkflows(list)
      }
    } catch (e) {
      addLog(`Failed to fetch workflows: ${e}`, "error")
    }
  }, [addLog])

  const fetchModuleTypes = useCallback(async () => {
    try {
      const r = await fetch("/api/workflows/modules/list", { credentials: "include" })
      if (r.ok) {
        const list = await r.json()
        setModuleTypes(list)
      }
    } catch (e) {
      addLog(`Failed to fetch module types: ${e}`, "error")
    }
  }, [addLog])

  useEffect(() => {
    fetchWorkflows()
    fetchModuleTypes()
  }, [fetchWorkflows, fetchModuleTypes])

  useEffect(() => {
    if (!projectId || !videoId) return
    const cached = loadFromCache(projectId, videoId)
    if (cached) {
      setStateByVideo((prev) => {
        if (prev[videoId]) return prev
        return { ...prev, [videoId]: { ...defaultVideoState(), ...cached } }
      })
    }
  }, [projectId, videoId])

  const saveCacheRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!projectId) return
    if (saveCacheRef.current) clearTimeout(saveCacheRef.current)
    saveCacheRef.current = setTimeout(() => {
      saveCacheRef.current = null
      for (const [vid, state] of Object.entries(stateByVideo)) {
        saveToCache(projectId, vid, state)
      }
    }, 500)
    return () => {
      if (saveCacheRef.current) clearTimeout(saveCacheRef.current)
    }
  }, [projectId, stateByVideo])

  const stateByVideoRef = useRef(stateByVideo)
  const projectIdRef = useRef(projectId)
  stateByVideoRef.current = stateByVideo
  projectIdRef.current = projectId ?? ""
  useEffect(() => {
    const onBeforeUnload = () => {
      const proj = projectIdRef.current
      if (!proj) return
      const state = stateByVideoRef.current
      for (const [vid, s] of Object.entries(state)) {
        saveToCache(proj, vid, s)
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  const pollJob = useCallback(
    async (jobId: string) => {
      const jobVideoId = activeJobVideoIdRef.current
      if (!jobVideoId) return
      try {
        const r = await fetch(`/api/workflows/jobs/${jobId}`, { credentials: "include" })
        if (!r.ok) return
        const job = await r.json()
        setStateByVideo((prev) => {
          const current = prev[jobVideoId] ?? defaultVideoState()
          const next = { ...current, jobProgress: job.progress ?? 0, jobMessage: job.message ?? "", jobLogs: job.logs ?? [] }
          if (job.status !== "completed" && job.status !== "failed") return { ...prev, [jobVideoId]: next }
          activeJobVideoIdRef.current = null
          const stepIndex = job.stepIndex
          const wf = current.workflow
          if (job.status === "completed") {
            const idx = stepIndex ?? (wf?.modules.length ?? 0) - 1
            const stepOutputUrls = idx >= 0 && job.outputUrl ? { ...current.stepOutputUrls, [idx]: job.outputUrl } : current.stepOutputUrls
            const stepOutputContentTypes = idx >= 0 && job.outputContentType ? { ...current.stepOutputContentTypes, [idx]: job.outputContentType } : current.stepOutputContentTypes
            const statuses: Record<number, StepStatus> = {}
            const endIdx = stepIndex != null ? stepIndex + 1 : (wf?.modules.length ?? 0)
            for (let i = 0; i < endIdx; i++) statuses[i] = "done"
            return { ...prev, [jobVideoId]: { ...next, activeJobId: null, runningAll: false, jobProgress: 100, stepOutputUrls, stepOutputContentTypes, stepStatuses: statuses } }
          }
          const failedIdx = job.stepResults?.findIndex((s: { success: boolean }) => !s.success) ?? stepIndex ?? 0
          const statuses: Record<number, StepStatus> = {}
          for (let i = 0; i < (wf?.modules.length ?? 0); i++) statuses[i] = i < failedIdx ? "done" : i === failedIdx ? "error" : "pending"
          return { ...prev, [jobVideoId]: { ...next, activeJobId: null, runningAll: false, stepStatuses: statuses } }
        })
        if (job.status === "completed") addLog("Workflow step completed", "info", jobVideoId)
        else if (job.status === "failed") addLog(`Failed: ${job.error}`, "error", jobVideoId)
      } catch {
        // ignore
      }
    },
    [addLog]
  )

  useEffect(() => {
    if (!activeJobId) return
    const interval = setInterval(() => pollJob(activeJobId), 500)
    return () => clearInterval(interval)
  }, [activeJobId, pollJob])

  const loadWorkflow = useCallback(
    async (id: string) => {
      if (!videoId) return
      try {
        const r = await fetch(`/api/workflows/${id}`, { credentials: "include" })
        if (r.ok) {
          const def = await r.json()
          updateVideoState(videoId, { workflow: def, currentWorkflowId: id, stepStatuses: {} })
        } else {
          addLog(`Workflow not found: ${id}`, "error")
        }
      } catch (e) {
        addLog(`Failed to load workflow: ${e}`, "error")
      }
    },
    [addLog, videoId, updateVideoState]
  )

  const saveWorkflow = useCallback(
    async (id: string) => {
      if (!workflow) return
      setSaving(true)
      try {
        const r = await fetch(`/api/workflows/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(workflow),
        })
        if (r.ok) {
          addLog(`Workflow saved: ${id}`)
          await fetchWorkflows()
        } else {
          const err = await r.json().catch(() => ({}))
          addLog(`Save failed: ${err.error || r.status}`, "error")
        }
      } catch (e) {
        addLog(`Save failed: ${e}`, "error")
      } finally {
        setSaving(false)
      }
    },
    [workflow, addLog, fetchWorkflows]
  )

  useEffect(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, String(autoSave))
    } catch {
      // ignore
    }
  }, [autoSave])

  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!autoSave || !currentWorkflowId || !workflow) return
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    autoSaveRef.current = setTimeout(() => {
      autoSaveRef.current = null
      saveWorkflow(currentWorkflowId)
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (autoSaveRef.current) clearTimeout(autoSaveRef.current)
    }
  }, [autoSave, currentWorkflowId, workflow, saveWorkflow])

  const createNewWorkflow = () => {
    if (!videoId) return
    const id = `workflow_${Date.now()}`
    const name = newWorkflowName || "New Workflow"
    updateVideoState(videoId, {
      workflow: { id, name, modules: [] },
      currentWorkflowId: id,
      stepStatuses: {},
    })
    setNewWorkflowName("")
    setWorkflows((prev) => [...prev.filter((w) => w.id !== id), { id, name }])
  }

  const addModule = (type: string) => {
    if (!videoId || !workflow) return
    const meta = moduleTypes.find((m) => m.type === type)
    const params: Record<string, unknown> = {}
    for (const p of meta?.paramsSchema ?? []) {
      if (p.default !== undefined) params[p.key] = p.default
    }
    const prevModules = workflow.modules
    const lastVideoOutput = prevModules
      .flatMap((m) => (m.outputs?.video ? [m.outputs.video] : []))
      .pop()
    const nextVideoNum =
      prevModules.reduce((n, m) => {
        const v = m.outputs?.video
        const match = v?.match(/^video_(\d+)$/)
        return match ? Math.max(n, parseInt(match[1], 10)) : n
      }, 0) + 1
    const nextTextNum =
      prevModules.reduce((n, m) => {
        const v = m.outputs?.text
        const match = v?.match(/^text_(\d+)$/)
        return match ? Math.max(n, parseInt(match[1], 10)) : n
      }, 0) + 1
    const inputs: Record<string, string> = {}
    const outputs: Record<string, string> = {}
    for (const slot of meta?.inputSlots ?? []) {
      if (slot.kind === "video") {
        inputs[slot.key] = lastVideoOutput ?? "source"
      }
    }
    for (const slot of meta?.outputSlots ?? []) {
      if (slot.kind === "video") {
        outputs[slot.key] = `video_${nextVideoNum}`
      }
      if (slot.kind === "text") {
        outputs[slot.key] = `text_${nextTextNum}`
      }
    }
    const newMod: WorkflowModuleDef = {
      id: generateId(),
      type,
      params: Object.keys(params).length ? params : undefined,
      ...(Object.keys(inputs).length ? { inputs } : undefined),
      ...(Object.keys(outputs).length ? { outputs } : undefined),
    }
    updateVideoState(videoId, {
      workflow: {
        ...workflow,
        modules: [...prevModules, newMod],
      },
    })
    if (projectId) {
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          items: [{ moduleId: newMod.id, moduleType: type }],
        }),
      })
        .then(() => refreshAssets())
        .catch(() => {})
    }
  }
  addModuleRef.current = addModule

  useEffect(() => {
    if (!workflow || !videoId) {
      setOnSelectModule(null)
      return
    }
    setOnSelectModule((type: string) => {
      addModuleRef.current(type)
      closeAddStepPanel()
    })
    return () => setOnSelectModule(null)
  }, [workflow, videoId, setOnSelectModule, closeAddStepPanel])

  const removeModule = (index: number) => {
    if (!projectId || !videoId || !workflow) return
    const removed = workflow.modules[index]
    const nextStatuses = { ...stepStatuses }
    delete nextStatuses[index]
    updateVideoState(videoId, {
      workflow: { ...workflow, modules: workflow.modules.filter((_, i) => i !== index) },
      stepStatuses: nextStatuses,
    })
    if (removed?.id) {
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ moduleIds: [removed.id] }),
      })
        .then(() => refreshAssets())
        .catch(() => {})
    }
  }

  const moveModule = (index: number, dir: "up" | "down") => {
    if (!videoId || !workflow) return
    const newIdx = dir === "up" ? index - 1 : index + 1
    if (newIdx < 0 || newIdx >= workflow.modules.length) return
    const arr = [...workflow.modules]
    ;[arr[index], arr[newIdx]] = [arr[newIdx], arr[index]]
    const nextStatuses = { ...stepStatuses }
    const a = nextStatuses[index]
    const b = nextStatuses[newIdx]
    nextStatuses[index] = b ?? "pending"
    nextStatuses[newIdx] = a ?? "pending"
    updateVideoState(videoId, { workflow: { ...workflow, modules: arr }, stepStatuses: nextStatuses })
  }

  const updateModuleParams = (index: number, params: Record<string, unknown>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], params }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  const updateModuleInputs = (index: number, inputs: Record<string, string>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], inputs }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  const updateModuleOutputs = (index: number, outputs: Record<string, string>) => {
    if (!videoId || !workflow) return
    const mods = [...workflow.modules]
    mods[index] = { ...mods[index], outputs }
    updateVideoState(videoId, { workflow: { ...workflow, modules: mods } })
  }

  const getAvailableVariablesForModule = (moduleIndex: number): string[] => {
    const vars = new Set<string>(["source"])
    for (let i = 0; i < moduleIndex; i++) {
      const m = workflow?.modules[i]
      if (m?.outputs) {
        for (const v of Object.values(m.outputs)) vars.add(v)
      }
    }
    return Array.from(vars).sort()
  }

  const runStep = async (stepIndex: number) => {
    if (!projectId || !videoId || !currentWorkflowId || !workflow) {
      addLog("Select a project, video and workflow first", "warn", videoId ?? undefined)
      return
    }
    updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "running" }, jobLogs: [] })
    addLog(`Running step ${stepIndex + 1}...`, "info", videoId)
    try {
      const body = { projectId, videoId, workflow }
      const r = await fetch(`/api/workflows/${currentWorkflowId}/step/${stepIndex}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(async () => ({ error: await r.text().catch(() => String(r.status)) }))
      if (r.status === 202 && data.jobId) {
        activeJobVideoIdRef.current = videoId
        updateVideoState(videoId, { activeJobId: data.jobId, activeJobStepIndex: stepIndex })
      } else if (!r.ok) {
        updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "error" } })
        addLog(`Step ${stepIndex + 1} failed: ${data.error || r.status}`, "error", videoId)
      }
    } catch (e) {
      updateVideoState(videoId, { stepStatuses: { ...stepStatuses, [stepIndex]: "error" } })
      addLog(`Step failed: ${e}`, "error", videoId)
    }
  }

  const runAll = async () => {
    if (!projectId || !videoId || !currentWorkflowId || !workflow?.modules.length) {
      addLog("Select project, video and workflow with modules", "warn", videoId ?? undefined)
      return
    }
    activeJobVideoIdRef.current = videoId
    updateVideoState(videoId, { runningAll: true, stepStatuses: {}, jobLogs: [] })
    addLog("Running workflow...", "info", videoId)
    try {
      const body = { projectId, videoId, workflow }
      const r = await fetch(`/api/workflows/${currentWorkflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      })
      const data = await r.json().catch(async () => ({ error: await r.text().catch(() => String(r.status)) }))
      if (r.status === 202 && data.jobId) {
        updateVideoState(videoId, { activeJobId: data.jobId, activeJobStepIndex: undefined })
      } else if (!r.ok) {
        addLog(`Workflow failed: ${data.error || r.status}`, "error", videoId)
        updateVideoState(videoId, { runningAll: false })
      }
    } catch (e) {
      addLog(`Workflow failed: ${e}`, "error", videoId)
      updateVideoState(videoId, { runningAll: false })
    }
  }

  const exportWorkflow = () => {
    if (!workflow) return
    const blob = new Blob([JSON.stringify(workflow, null, 2)], {
      type: "application/json",
    })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `workflow_${currentWorkflowId || "export"}.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const importWorkflow = () => {
    if (!videoId) return
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const def = JSON.parse(text) as WorkflowDefinition
        updateVideoState(videoId, {
          workflow: def,
          currentWorkflowId: def.id ?? `imported_${Date.now()}`,
          stepStatuses: {},
        })
        addLog("Workflow imported")
      } catch (err) {
        addLog(`Import failed: ${err}`, "error")
      }
    }
    input.click()
  }

  const getModuleLabel = (type: string) =>
    moduleTypes.find((m) => m.type === type)?.label ?? type

  const handlePreview = (url: string, label: string, contentType?: string) => {
    setPreviewVideo({ url, label, contentType: contentType ?? "video/mp4" })
  }

  const handleOpenCrop = (index: number) => {
    setCropModuleIndex(index)
    setCropModalOpen(true)
  }

  const handleSaveCrop = (crop: { left: number; top: number; right: number; bottom: number }) => {
    if (cropModuleIndex === null) return
    updateModuleParams(cropModuleIndex, { ...workflow!.modules[cropModuleIndex].params, ...crop })
  }

  const handleTestCrop = async (crop: { left: number; top: number; right: number; bottom: number; time: number }) => {
    if (!projectId || !videoId || !currentWorkflowId) throw new Error("Missing context")
    const r = await fetch(`/api/workflows/${currentWorkflowId}/test-crop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ projectId, videoId, ...crop }),
    })
    if (!r.ok) throw new Error("Failed to generate preview")
    const data = await r.json()
    return data.image
  }

  if (!projectId || !videoId) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Select a video in the project to edit workflows
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-panel-2">
      <div className="px-4 pt-3 pb-3 border-b shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            className="h-8 rounded-md border border-input bg-background px-3 text-sm min-w-[160px] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1"
            value={currentWorkflowId ?? ""}
            onChange={(e) => {
              const v = e.target.value
              if (v) loadWorkflow(v)
              else if (videoId) updateVideoState(videoId, { currentWorkflowId: null, workflow: null })
            }}
          >
            <option value="">— Select workflow —</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name ?? w.id}
              </option>
            ))}
          </select>
          <div className="h-5 w-px bg-border" aria-hidden />
          <div className="flex items-center gap-1.5">
            <Input
              className="h-8 w-36 text-sm"
              placeholder="New workflow name"
              value={newWorkflowName}
              onChange={(e) => setNewWorkflowName(e.target.value)}
            />
            <Button variant="outline" size="sm" className="h-8" onClick={createNewWorkflow}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              New
            </Button>
          </div>
          <div className="h-5 w-px bg-border" aria-hidden />
          <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-md hover:bg-muted/60 cursor-pointer select-none transition-colors">
            <input
              type="checkbox"
              checked={autoSave}
              onChange={(e) => setAutoSave(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-primary cursor-pointer"
            />
            <span className="text-xs font-medium text-foreground">Auto-save</span>
          </label>
          <div className="h-5 w-px bg-border" aria-hidden />
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2"
              onClick={() => currentWorkflowId && saveWorkflow(currentWorkflowId)}
              disabled={!currentWorkflowId || saving}
              title="Save workflow"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={exportWorkflow} disabled={!workflow} title="Export">
              <FileDown className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={importWorkflow} title="Import">
              <FileUp className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {workflow && (
          <>
            {showProgress && (activeJobId || jobLogs.length > 0) && (
              <div className="rounded-lg border bg-muted/40 p-3 space-y-2.5 shadow-sm">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{jobMessage || "Running..."}</span>
                  {activeJobId && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300 rounded-full"
                    style={{ width: `${jobProgress}%` }}
                  />
                </div>
                <div className="max-h-24 overflow-y-auto font-mono text-[10px] text-muted-foreground space-y-0.5 rounded bg-background/50 px-2 py-1.5">
                  {jobLogs.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between px-1">
              <span className="text-sm font-medium text-muted-foreground">
                {workflow.name} · {workflow.modules.length} {workflow.modules.length === 1 ? "module" : "modules"}
              </span>
              <Button
                size="sm"
                className="h-8"
                onClick={runAll}
                disabled={runningAll || !!activeJobId || !workflow.modules.length}
              >
                {runningAll ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                )}
                Run All
              </Button>
            </div>

            <div className="space-y-2.5">
              {workflow.modules.map((mod, idx) => (
                <ModuleBlock
                  key={mod.id}
                  module={mod}
                  index={idx}
                  moduleTypes={moduleTypes}
                  status={stepStatuses[idx] ?? "pending"}
                  outputUrl={stepOutputUrls[idx]}
                  expanded={expandedModuleIndex === idx}
                  onToggleExpand={() => setExpandedModuleIndex((i) => (i === idx ? null : idx))}
                  onRemove={() => removeModule(idx)}
                  onMoveUp={() => moveModule(idx, "up")}
                  onMoveDown={() => moveModule(idx, "down")}
                  onParamsChange={(params) => updateModuleParams(idx, params)}
                  onInputsChange={(inputs) => updateModuleInputs(idx, inputs)}
                  onOutputsChange={(outputs) => updateModuleOutputs(idx, outputs)}
                  onRunStep={() => runStep(idx)}
                  onPreview={() => stepOutputUrls[idx] && handlePreview(stepOutputUrls[idx], `Step ${idx + 1}`, stepOutputContentTypes[idx])}
                  getModuleLabel={getModuleLabel}
                  getAvailableVariables={() => getAvailableVariablesForModule(idx)}
                  onOpenCrop={() => handleOpenCrop(idx)}
                  onOpenPromptBuilder={(paramKey) => setOpenPromptBuilder({ index: idx, paramKey })}
                />
              ))}
              <div className="flex justify-center pt-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/80"
                  onClick={openAddStepPanel}
                  title="Add step"
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
      {openPromptBuilder && workflow && (() => {
        const { index, paramKey } = openPromptBuilder
        const mod = workflow.modules[index]
        const params = mod?.params ?? {}
        const currentValue = String(params[paramKey] ?? "")
        const meta = moduleTypes.find((m) => m.type === mod?.type)
        const paramLabel = meta?.paramsSchema?.find((p) => p.key === paramKey)?.label ?? paramKey
        return (
          <PromptBuilderModal
            isOpen={true}
            onClose={() => setOpenPromptBuilder(null)}
            value={currentValue}
            onChange={(v) => updateModuleParams(index, { ...params, [paramKey]: v })}
            availableVariables={getAvailableVariablesForModule(index)}
            label={paramLabel}
          />
        )
      })()}

      {cropModalOpen && cropModuleIndex !== null && workflow && (selectedVideo?.streamUrl ?? selectedVideo?.playUrl) && (
        <CropModal
          isOpen={cropModalOpen}
          onClose={() => setCropModalOpen(false)}
          onSave={handleSaveCrop}
          videoUrl={selectedVideo!.streamUrl ?? selectedVideo!.playUrl!}
          initialCrop={(() => {
            const p = workflow.modules[cropModuleIndex].params ?? {};
            return {
              left: Math.min(100, Math.max(0, Number(p.left ?? 0))),
              top: Math.min(100, Math.max(0, Number(p.top ?? 0))),
              right: Math.min(100, Math.max(0, Number(p.right ?? 0))),
              bottom: Math.min(100, Math.max(0, Number(p.bottom ?? 0))),
            };
          })()}
          onTestCrop={handleTestCrop}
        />
      )}
    </div>
  )
}

function ModuleBlock({
  module,
  index,
  moduleTypes,
  status,
  outputUrl,
  expanded,
  onToggleExpand,
  onRemove,
  onMoveUp,
  onMoveDown,
  onParamsChange,
  onInputsChange,
  onOutputsChange,
  onRunStep,
  onPreview,
  getModuleLabel,
  getAvailableVariables,
  onOpenCrop,
  onOpenPromptBuilder,
}: {
  module: WorkflowModuleDef
  index: number
  moduleTypes: ModuleMeta[]
  status: StepStatus
  outputUrl?: string
  expanded: boolean
  onToggleExpand: () => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onParamsChange: (params: Record<string, unknown>) => void
  onInputsChange: (inputs: Record<string, string>) => void
  onOutputsChange: (outputs: Record<string, string>) => void
  onRunStep: () => void
  onPreview: () => void
  getModuleLabel: (type: string) => string
  getAvailableVariables: () => string[]
  onOpenCrop?: () => void
  onOpenPromptBuilder?: (paramKey: string) => void
}) {
  const meta = moduleTypes.find((m) => m.type === module.type)
  const params = module.params ?? {}
  const paramsSchema = meta?.paramsSchema ?? []
  const paramsToShow = expanded ? paramsSchema : []

  const StatusIcon = () => {
    if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin" />
    if (status === "done") return <Check className="h-3.5 w-3.5 text-green-600" />
    if (status === "error") return <XCircle className="h-3.5 w-3.5 text-destructive" />
    return <span className="w-3.5 h-3.5 rounded-full border border-muted-foreground/50" />
  }

  const renderParam = (p: { key: string; label: string; type: string; default?: unknown; min?: number; max?: number; options?: { value: string; label: string }[] }) => (
    <div key={p.key} className="flex items-center gap-2">
      <label className="text-xs text-muted-foreground w-20 shrink-0">{p.label}</label>
      {p.type === "prompt" && (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
            {(String(params[p.key] ?? p.default ?? "") || "Empty").slice(0, 60)}
            {(String(params[p.key] ?? p.default ?? "").length > 60) ? "…" : ""}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => onOpenPromptBuilder?.(p.key)}
          >
            <Pencil className="h-3 w-3 mr-1" />
            Edit
          </Button>
        </div>
      )}
      {p.type === "number" && (() => {
        const raw = Number(params[p.key] ?? p.default ?? 0)
        const clamped = p.min != null || p.max != null
          ? Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, raw))
          : raw
        return (
          <Input
            type="number"
            className="h-7 text-xs"
            value={clamped}
            min={p.min}
            max={p.max}
            onChange={(e) => {
              let v = parseFloat(e.target.value) || 0
              if (p.min != null) v = Math.max(p.min, v)
              if (p.max != null) v = Math.min(p.max, v)
              onParamsChange({ ...params, [p.key]: v })
            }}
          />
        )
      })()}
      {p.type === "string" && (
        p.options ? (
          <select
            className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
            value={String(params[p.key] ?? p.default ?? "")}
            onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
          >
            {p.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <Input
            type="text"
            className="h-7 text-xs flex-1"
            value={String(params[p.key] ?? p.default ?? "")}
            onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.value })}
          />
        )
      )}
      {p.type === "boolean" && (
        <input
          type="checkbox"
          checked={Boolean(params[p.key] ?? p.default)}
          onChange={(e) => onParamsChange({ ...params, [p.key]: e.target.checked })}
          className="h-4 w-4"
        />
      )}
    </div>
  )

  return (
    <div className={`rounded-lg border bg-panel-3 text-sm transition-colors ${expanded ? "p-3 shadow-sm" : "px-3 py-2"}`}>
      <div className={`flex items-center justify-between gap-2 ${expanded ? "mb-3" : ""}`}>
        <div
          className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer group"
          onClick={onToggleExpand}
          onKeyDown={(e) => e.key === "Enter" && onToggleExpand()}
          role="button"
          tabIndex={0}
        >
          <button
            type="button"
            className="shrink-0 p-0.5 -ml-0.5 rounded hover:bg-muted/60 transition-colors"
            onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
          </button>
          <StatusIcon />
          <span className="font-medium truncate">{getModuleLabel(module.type)}</span>
          <span className="text-xs text-muted-foreground tabular-nums">#{index + 1}</span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {outputUrl && (
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onPreview} title="Preview result">
              <Eye className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onRunStep}
            title="Run this step"
            disabled={status === "running"}
          >
            <Play className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveUp} title="Move up">
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onMoveDown} title="Move down">
            <ChevronDown className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onRemove} title="Remove">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {expanded && (meta?.inputSlots?.length ?? 0) > 0 && (
        <div className="space-y-2 mb-3 pt-2 border-t">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Inputs</span>
          {meta!.inputSlots!.map((slot) => (
            <div key={slot.key} className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-20 shrink-0">{slot.label}</label>
              <select
                className="h-7 rounded-md border border-input bg-background px-2 text-xs flex-1"
                value={
                  module.inputs?.[slot.key] ??
                  (slot.kind === "video" ? (index === 0 ? "source" : getAvailableVariables().pop() ?? "source") : "")
                }
                onChange={(e) =>
                  onInputsChange({ ...(module.inputs ?? {}), [slot.key]: e.target.value })
                }
              >
                {getAvailableVariables().map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {expanded && (meta?.outputSlots?.length ?? 0) > 0 && (
        <div className="space-y-2 mb-3 pt-2 border-t">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Outputs</span>
          {meta!.outputSlots!.map((slot) => (
            <div key={slot.key} className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground w-20 shrink-0">{slot.label}</label>
              <Input
                type="text"
                className="h-7 text-xs flex-1"
                placeholder={`e.g. video_${index + 1}`}
                value={module.outputs?.[slot.key] ?? ""}
                onChange={(e) =>
                  onOutputsChange({ ...(module.outputs ?? {}), [slot.key]: e.target.value })
                }
              />
            </div>
          ))}
        </div>
      )}
      {paramsToShow.length > 0 && (
        <div className="space-y-2 pt-2 border-t">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Parameters</span>
          <div className="space-y-2">
            {paramsToShow.map((p) => renderParam(p))}
          </div>
        </div>
      )}
      {expanded && module.type === "video.crop" && (
        <Button variant="outline" size="sm" className="w-full mt-3" onClick={() => onOpenCrop?.()}>
          <CropIcon className="h-3.5 w-3.5 mr-2" />
          Interactive Crop
        </Button>
      )}
    </div>
  )
}
