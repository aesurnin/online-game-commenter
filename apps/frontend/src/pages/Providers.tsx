import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useLogs } from "@/contexts/LogsContext"

type Provider = {
  id: string
  name: string
  urlPattern: string
  playSelectors: string[]
  endSelectors: string[]
  idleValueSelector: string | null
  idleSeconds: number
  consoleEndPatterns: string[]
}

export function Providers() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [newProvider, setNewProvider] = useState({
    name: "",
    urlPattern: "",
    playSelectors: "",
    idleValueSelector: "",
    idleSeconds: "40",
  })
  const navigate = useNavigate()
  const { addLog } = useLogs()

  async function fetchProviders() {
    const r = await fetch("/api/providers", { credentials: "include" })
    if (!r.ok) {
      if (r.status === 401) navigate("/login")
      return []
    }
    return r.json()
  }

  useEffect(() => {
    fetchProviders().then((list) => {
      setProviders(list)
      setLoading(false)
    })
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!newProvider.name.trim() || !newProvider.urlPattern.trim()) return
    addLog(`Adding provider: ${newProvider.name}`)
    try {
      const r = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: newProvider.name.trim(),
          urlPattern: newProvider.urlPattern.trim(),
          playSelectors: newProvider.playSelectors.split(",").map((s) => s.trim()).filter(Boolean),
          endSelectors: [],
          idleValueSelector: newProvider.idleValueSelector.trim() || undefined,
          idleSeconds: parseInt(newProvider.idleSeconds, 10) || 40,
          consoleEndPatterns: [],
        }),
      })
      if (r.ok) {
        const p = await r.json()
        setProviders((prev) => [...prev, p])
        setShowAdd(false)
        setNewProvider({ name: "", urlPattern: "", playSelectors: "", idleValueSelector: "", idleSeconds: "40" })
        addLog(`Provider added: ${p.name}`)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Add failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("Add failed: network error", "error")
    }
  }

  if (loading) return <div className="p-8">Loading...</div>

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-card">
        <div className="flex h-14 items-center justify-between px-4">
          <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard")}>
            ← Dashboard
          </Button>
          <h1 className="font-semibold">Provider Templates</h1>
        </div>
      </header>
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Known providers</CardTitle>
            <CardDescription>
              When you paste a URL, the system detects the provider and uses its triggers for recording.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {providers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No providers yet. Add one below.</p>
            ) : (
              providers.map((p) => (
                <div key={p.id} className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">{p.name}</p>
                  <p className="text-muted-foreground text-xs mt-1">URL: {p.urlPattern}</p>
                  <p className="text-xs mt-1">
                    Start: {(p.playSelectors || []).join(", ") || "—"}
                  </p>
                  <p className="text-xs">
                    End: {p.idleValueSelector ? `Idle ${p.idleSeconds}s on "${p.idleValueSelector}"` : "—"}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        {showAdd ? (
          <Card>
            <CardHeader>
              <CardTitle>Add provider</CardTitle>
              <CardDescription>Add a new provider template for automatic recording triggers.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground">Name</label>
                  <Input
                    value={newProvider.name}
                    onChange={(e) => setNewProvider((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. BGaming"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">URL pattern (substring match)</label>
                  <Input
                    value={newProvider.urlPattern}
                    onChange={(e) => setNewProvider((p) => ({ ...p, urlPattern: e.target.value }))}
                    placeholder="e.g. bgaming-network.com"
                    required
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Play selectors (comma-separated)</label>
                  <Input
                    value={newProvider.playSelectors}
                    onChange={(e) => setNewProvider((p) => ({ ...p, playSelectors: e.target.value }))}
                    placeholder="#playBtn, button#playBtn"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Idle value selector (e.g. Total Win)</label>
                  <Input
                    value={newProvider.idleValueSelector}
                    onChange={(e) => setNewProvider((p) => ({ ...p, idleValueSelector: e.target.value }))}
                    placeholder="[class*='total-win']"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">Idle seconds</label>
                  <Input
                    type="number"
                    value={newProvider.idleSeconds}
                    onChange={(e) => setNewProvider((p) => ({ ...p, idleSeconds: e.target.value }))}
                    min={1}
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit">Add</Button>
                  <Button type="button" variant="outline" onClick={() => setShowAdd(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Button onClick={() => setShowAdd(true)}>Add provider template</Button>
        )}
      </div>
    </div>
  )
}
