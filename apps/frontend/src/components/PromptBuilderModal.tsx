import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { X } from "lucide-react"

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g

function getPlaceholders(text: string): string[] {
  const set = new Set<string>()
  let m: RegExpExecArray | null
  PLACEHOLDER_RE.lastIndex = 0
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) set.add(m[1])
  return Array.from(set).sort()
}

interface PromptBuilderModalProps {
  isOpen: boolean
  onClose: () => void
  value: string
  onChange: (value: string) => void
  availableVariables: string[]
  label?: string
}

export function PromptBuilderModal({
  isOpen,
  onClose,
  value,
  onChange,
  availableVariables,
  label = "Prompt",
}: PromptBuilderModalProps) {
  const [localValue, setLocalValue] = useState(value)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) setLocalValue(value)
  }, [isOpen, value])

  const insertAtCursor = (insert: string) => {
    const ta = textareaRef.current
    if (!ta) return
    const start = ta.selectionStart
    const end = ta.selectionEnd
    const before = localValue.slice(0, start)
    const after = localValue.slice(end)
    const next = before + insert + after
    setLocalValue(next)
    setTimeout(() => {
      const pos = start + insert.length
      ta.focus()
      ta.setSelectionRange(pos, pos)
    }, 0)
  }

  const handleSave = () => {
    onChange(localValue)
    onClose()
  }

  const placeholders = getPlaceholders(localValue)

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">{label} — insert variables</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
          <div>
            <label className="text-xs text-muted-foreground block mb-1.5">Text (use placeholders below)</label>
            <textarea
              ref={textareaRef}
              className="w-full min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
              value={localValue}
              onChange={(e) => setLocalValue(e.target.value)}
              placeholder="e.g. Summarize the previous step: {{text_1}}"
              spellCheck={false}
            />
          </div>

          {placeholders.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Placeholders in text</span>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {placeholders.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center rounded-md bg-primary/15 text-primary px-2 py-0.5 text-xs font-mono"
                  >
                    {`{{${name}}}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Insert variable</span>
            <p className="text-xs text-muted-foreground mt-0.5 mb-2">
              Click to insert at cursor. Format: <code className="bg-muted px-1 rounded">{`{{variableName}}`}</code>
            </p>
            <div className="flex flex-wrap gap-2">
              {availableVariables.length === 0 ? (
                <span className="text-xs text-muted-foreground">No text variables from previous steps (e.g. text_1).</span>
              ) : (
                availableVariables.map((name) => (
                  <Button
                    key={name}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="font-mono text-xs h-8"
                    onClick={() => insertAtCursor(`{{${name}}}`)}
                  >
                    {`{{${name}}}`}
                  </Button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="p-4 border-t flex justify-end gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave}>
            Apply
          </Button>
        </div>
      </div>
    </div>
  )
}
