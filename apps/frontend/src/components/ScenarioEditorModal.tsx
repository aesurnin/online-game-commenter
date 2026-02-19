import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { X, Sparkles, Loader2 } from "lucide-react"

function parseSlotsFromJson(jsonStr: string): Array<{ key: string; kind: string; label?: string }> {
  const trimmed = jsonStr.trim()
  if (!trimmed) return []
  try {
    const obj = JSON.parse(trimmed) as { slots?: unknown[] }
    if (!Array.isArray(obj.slots)) return []
    return obj.slots
      .filter((s): s is Record<string, unknown> => s != null && typeof s === "object")
      .map((s) => ({
        key: String(s.key ?? ""),
        kind: String(s.kind ?? "video"),
        label: typeof s.label === "string" ? s.label : undefined,
      }))
      .filter((s) => s.key)
  } catch {
    return []
  }
}

function isJsonEmpty(str: string): boolean {
  return str.trim().length === 0
}

export interface ScenarioEditorModalProps {
  isOpen: boolean
  onClose: () => void
  initialPrompt: string
  initialSceneJson: string
  onSave: (prompt: string, sceneJson: string, slots: Array<{ key: string; kind: string; label?: string }>) => void
  onGenerate: (prompt: string) => Promise<{ json: Record<string, unknown>; slots: Array<{ key: string; kind: string; label?: string }> } | { error: string }>
}

export function ScenarioEditorModal({
  isOpen,
  onClose,
  initialPrompt,
  initialSceneJson,
  onSave,
  onGenerate,
}: ScenarioEditorModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [sceneJson, setSceneJson] = useState(initialSceneJson)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setPrompt(initialPrompt)
      setSceneJson(initialSceneJson)
    }
  }, [isOpen, initialPrompt, initialSceneJson])

  const hasJson = !isJsonEmpty(sceneJson)
  const canGenerate = !hasJson && prompt.trim().length > 0

  const handleGenerate = async () => {
    if (!canGenerate) return
    setGenerating(true)
    try {
      const result = await onGenerate(prompt.trim())
      if ("error" in result) {
        return
      }
      setSceneJson(JSON.stringify(result.json, null, 2))
    } finally {
      setGenerating(false)
    }
  }

  const handleSave = () => {
    const slots = parseSlotsFromJson(sceneJson)
    onSave(prompt, sceneJson, slots)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-3xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">Scenario Editor</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Prompt (for Generate)</label>
            <textarea
              className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Create a video montage with 3 clips. Use slots clip_1, clip_2, clip_3."
              spellCheck={false}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={!canGenerate || generating}
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
              Generate
            </Button>
            {hasJson && (
              <span className="text-xs text-muted-foreground">JSON present — Generate does nothing. Clear JSON to generate from prompt.</span>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground block mb-1.5">Scenario JSON (manual or from Generate)</label>
            <textarea
              className="w-full min-h-[240px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
              value={sceneJson}
              onChange={(e) => setSceneJson(e.target.value)}
              placeholder='{"slots": [...], "scene": {...}}'
              spellCheck={false}
            />
          </div>
        </div>

        <div className="p-4 border-t flex justify-end gap-2 shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}
