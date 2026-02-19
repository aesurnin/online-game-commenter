import { useState, useRef, useEffect } from "react"
import ReactMarkdown from "react-markdown"
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

type Tab = "edit" | "preview"

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
  const [tab, setTab] = useState<Tab>("edit")
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isOpen) {
      setLocalValue(value)
      setTab("edit")
    }
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
      <div className="bg-background rounded-lg shadow-lg max-w-5xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between shrink-0">
          <h3 className="font-semibold">{label} — insert variables</h3>
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col gap-4 min-h-0">
          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center gap-0 mb-1.5">
              <button
                type="button"
                className={`px-3 py-1 text-xs font-medium rounded-t-md border border-b-0 transition-colors ${
                  tab === "edit"
                    ? "bg-background text-foreground border-input"
                    : "bg-muted/50 text-muted-foreground border-transparent hover:text-foreground"
                }`}
                onClick={() => setTab("edit")}
              >
                Edit
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-xs font-medium rounded-t-md border border-b-0 transition-colors ${
                  tab === "preview"
                    ? "bg-background text-foreground border-input"
                    : "bg-muted/50 text-muted-foreground border-transparent hover:text-foreground"
                }`}
                onClick={() => setTab("preview")}
              >
                MD Preview
              </button>
            </div>

            {tab === "edit" ? (
              <textarea
                ref={textareaRef}
                className="w-full flex-1 min-h-[400px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-y"
                value={localValue}
                onChange={(e) => setLocalValue(e.target.value)}
                placeholder="e.g. Summarize the previous step: {{text_1}}"
                spellCheck={false}
              />
            ) : (
              <div className="flex-1 min-h-[400px] rounded-md border border-input bg-background px-4 py-3 overflow-auto">
                {localValue.trim() ? (
                  <article className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown
                      components={{
                        pre: ({ children }) => <pre className="whitespace-pre-wrap break-words">{children}</pre>,
                      }}
                    >
                      {localValue}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <span className="text-sm text-muted-foreground">Nothing to preview</span>
                )}
              </div>
            )}
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
                    onClick={() => {
                      insertAtCursor(`{{${name}}}`)
                      setTab("edit")
                    }}
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
