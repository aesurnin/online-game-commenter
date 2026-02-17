import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useLogs } from "@/contexts/LogsContext"
import { useTheme } from "@/contexts/ThemeContext"

export function Login() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { addLog } = useLogs()
  const { theme, toggleTheme } = useTheme()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    addLog(`Login attempt: ${email}`)
    setLoading(true)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "include",
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || "Login failed")
        addLog(`Login failed: ${data.error || "Unknown"}`, "error")
        return
      }
      addLog("Login successful")
      navigate("/dashboard")
    } catch {
      setError("Network error")
      addLog("Login failed: network error", "error")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-panel-0 p-4 relative">
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-4 right-4 h-9 w-9"
        onClick={toggleTheme}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </Button>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Sign in to your account</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Email</label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
