import { useEffect, useState, useRef } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Plus, Trash2, Video, Upload, Link, Loader2, XCircle, Square } from "lucide-react"
import { useLogs } from "@/contexts/LogsContext"

type VideoEntity = {
  id: string
  status: string
  sourceUrl?: string
  playUrl?: string
  metadata?: { error?: string }
  createdAt?: string
}

export function ProjectView() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<{ id: string; name: string } | null>(null)
  const [videos, setVideos] = useState<VideoEntity[]>([])
  const [selectedVideo, setSelectedVideo] = useState<VideoEntity | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [urlInput, setUrlInput] = useState("")
  const [urlLoading, setUrlLoading] = useState(false)
  const [recordingTick, setRecordingTick] = useState(0)
  const [livePreviewUrl, setLivePreviewUrl] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [stopping, setStopping] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { addLog } = useLogs()

  async function fetchProject() {
    if (!id) return
    const r = await fetch(`/api/projects/${id}`, { credentials: "include" })
    if (!r.ok) throw new Error("Not found")
    return r.json()
  }

  async function fetchVideos() {
    if (!id) return []
    const r = await fetch(`/api/projects/${id}/videos?_=${Date.now()}`, {
      credentials: "include",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    })
    return r.ok ? r.json() : []
  }

  function refreshVideosAndSelection() {
    fetchVideos().then((vids) => {
      setVideos(vids)
      setSelectedVideo((prev) => {
        if (!prev) return null
        const found = vids.find((v) => v.id === prev.id)
        return found ?? prev
      })
    })
  }

  useEffect(() => {
    if (!id) return
    addLog(`Loading project ${id}`)
    fetchProject()
      .then((p) => {
        setProject(p)
        addLog(`Project loaded: ${p?.name}`)
      })
      .catch(() => {
        addLog("Project not found, redirecting", "warn")
        navigate("/dashboard")
      })
    fetchVideos().then((vids) => {
      setVideos(vids)
      addLog(`Loaded ${vids.length} video(s)`)
    })
  }, [id, navigate, addLog])

  const hasProcessing = videos.some((v) => v.status === "processing")
  useEffect(() => {
    if (!id || !hasProcessing) return
    const interval = setInterval(refreshVideosAndSelection, 1500)
    return () => clearInterval(interval)
  }, [id, hasProcessing])

  useEffect(() => {
    if (!selectedVideo || selectedVideo.status !== "processing") return
    const interval = setInterval(() => setRecordingTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [selectedVideo?.id, selectedVideo?.status])

  // Poll live preview from Docker worker (what the worker is actually recording)
  useEffect(() => {
    if (!id || !selectedVideo || selectedVideo.status !== "processing") {
      if (livePreviewUrl) {
        URL.revokeObjectURL(livePreviewUrl)
        setLivePreviewUrl(null)
      }
      return
    }
    const videoId = selectedVideo.id
    let revoked = false
    const poll = async () => {
      try {
        const r = await fetch(`/api/projects/${id}/videos/${videoId}/live-preview?_=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        })
        if (revoked) return
        if (r.status === 200) {
          const blob = await r.blob()
          if (revoked) return
          setLivePreviewUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return URL.createObjectURL(blob)
          })
        } else {
          setLivePreviewUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return null
          })
        }
      } catch {
        if (!revoked) setLivePreviewUrl((old) => (old ? old : null))
      }
    }
    poll()
    const interval = setInterval(poll, 800)
    return () => {
      revoked = true
      clearInterval(interval)
      setLivePreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
    }
  }, [id, selectedVideo?.id, selectedVideo?.status])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !id) return
    addLog(`Upload started: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`)
    setUploading(true)
    setUploadProgress(0)

    const form = new FormData()
    form.append("file", file)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/projects/${id}/videos/upload`)
    xhr.withCredentials = true

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        setUploadProgress(Math.round((ev.loaded / ev.total) * 100))
      } else {
        setUploadProgress(null)
      }
    }

    xhr.onload = () => {
      setUploading(false)
      setUploadProgress(null)
      e.target.value = ""
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const v = JSON.parse(xhr.responseText)
          setVideos((prev) => [...prev, v])
          setSelectedVideo(v)
          setShowAddForm(false)
          addLog(`Video uploaded: ${v.id.slice(0, 8)}...`)
        } catch {
          addLog("Failed to parse upload response", "error")
        }
      } else {
        addLog(`Upload failed: ${xhr.status} ${xhr.statusText}`, "error")
      }
    }

    xhr.onerror = () => {
      setUploading(false)
      setUploadProgress(null)
      e.target.value = ""
      addLog("Upload failed: network error", "error")
    }

    xhr.send(form)
  }

  async function handleUrlSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!urlInput.trim() || !id) return
    addLog(`Adding video by URL: ${urlInput.trim()}`)
    setUrlLoading(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: urlInput.trim() }),
        credentials: "include",
      })
      if (r.ok) {
        const v = await r.json()
        setVideos((prev) => [...prev, v])
        setSelectedVideo(v)
        setShowAddForm(false)
        setUrlInput("")
        addLog(`Video added by URL: ${v.id.slice(0, 8)}...`)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`URL add failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("URL add failed: network error", "error")
    } finally {
      setUrlLoading(false)
    }
  }

  async function handleStopRecording(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Stopping recording ${video.id.slice(0, 8)}...`)
    setStopping(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}/stop`, {
        method: "POST",
        credentials: "include",
      })
      if (r.ok) {
        addLog(`Recording will stop and save shortly (worker must be running)`)
        refreshVideosAndSelection()
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Stop failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("Stop failed: network error", "error")
    } finally {
      setStopping(false)
    }
  }

  async function handleCancelRecording(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Cancelling recording ${video.id.slice(0, 8)}...`)
    setCancelling(true)
    try {
      const r = await fetch(`/api/projects/${id}/videos/${video.id}/cancel`, {
        method: "POST",
        credentials: "include",
      })
      if (r.ok) {
        addLog(`Recording cancelled`)
        refreshVideosAndSelection()
        setTimeout(refreshVideosAndSelection, 500)
        setTimeout(refreshVideosAndSelection, 1500)
      } else {
        const err = await r.json().catch(() => ({}))
        addLog(`Cancel failed: ${err.error || r.status}`, "error")
      }
    } catch {
      addLog("Cancel failed: network error", "error")
    } finally {
      setCancelling(false)
    }
  }

  async function handleDeleteVideo(e: React.MouseEvent, video: VideoEntity) {
    e.stopPropagation()
    if (!id) return
    addLog(`Deleting video ${video.id.slice(0, 8)}...`)
    const r = await fetch(`/api/projects/${id}/videos/${video.id}`, {
      method: "DELETE",
      credentials: "include",
    })
    if (r.ok) {
      setVideos((prev) => prev.filter((v) => v.id !== video.id))
      if (selectedVideo?.id === video.id) {
        setSelectedVideo(null)
      }
      addLog(`Video deleted`)
    } else {
      addLog(`Delete failed: ${r.status}`, "error")
    }
  }

  function handleAddClick() {
    setSelectedVideo(null)
    setShowAddForm(true)
    addLog("Add video form opened")
  }

  function handleVideoClick(video: VideoEntity) {
    setSelectedVideo(video)
    setShowAddForm(false)
    addLog(`Selected video ${video.id.slice(0, 8)}`)
  }

  if (!project) return <div className="p-8">Loading...</div>

  return (
    <div className="min-h-screen bg-muted/30 flex flex-col">
      <header className="border-b bg-card shrink-0">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                addLog("Navigating to dashboard")
                navigate("/dashboard")
              }}
            >
              ← Back
            </Button>
            <h1 className="font-semibold">{project.name}</h1>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Asset bar — left */}
        <aside className="w-56 shrink-0 border-r bg-card flex flex-col">
          <div className="p-2 flex items-center justify-between border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Videos
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleAddClick}
              title="Add video"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1">
            {videos.map((v) => (
              <div
                key={v.id}
                className={`group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer hover:bg-muted/80 transition-colors ${
                  selectedVideo?.id === v.id && !showAddForm ? "bg-muted" : ""
                }`}
                onClick={() => handleVideoClick(v)}
              >
                <Video className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-sm truncate min-w-0">
                  {v.status === "processing"
                    ? "Recording..."
                    : v.status === "cancelled"
                      ? "Cancelled"
                      : v.status === "failed"
                        ? "Failed"
                        : v.sourceUrl
                          ? `Video ${v.id.slice(0, 8)}`
                          : "No video"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => handleDeleteVideo(e, v)}
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </aside>

        {/* Center area — preview or upload form */}
        <main className="flex-1 flex items-center justify-center p-6 min-h-0 bg-muted/20">
          {showAddForm ? (
            <div className="w-full max-w-md space-y-6">
              <h3 className="font-medium text-center">Add video</h3>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleFileChange}
              />
              <div
                className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
                  uploading
                    ? "border-primary/50 bg-primary/5 cursor-wait"
                    : "border-muted-foreground/25 hover:border-muted-foreground/50 cursor-pointer"
                }`}
                onClick={() => !uploading && fileInputRef.current?.click()}
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-10 w-10 mx-auto text-primary mb-3 animate-spin" />
                    <p className="text-muted-foreground mb-4">
                      Uploading...
                      {uploadProgress != null && ` ${uploadProgress}%`}
                    </p>
                    <div className="w-full max-w-xs mx-auto h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-300"
                        style={{
                          width:
                            uploadProgress != null
                              ? `${uploadProgress}%`
                              : "30%",
                        }}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
                    <p className="text-muted-foreground mb-4">
                      Upload file from computer
                    </p>
                    <Button variant="outline">Select file</Button>
                  </>
                )}
              </div>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">or</span>
                </div>
              </div>
              <form onSubmit={handleUrlSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <Link className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="url"
                    placeholder="Video URL"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    className="pl-9"
                  />
                </div>
                <Button type="submit" disabled={urlLoading || !urlInput.trim()}>
                  {urlLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Add"
                  )}
                </Button>
              </form>
            </div>
          ) : selectedVideo?.status === "processing" ? (
            <div className="w-full max-w-4xl flex flex-col gap-2">
              <div className="relative aspect-video bg-black rounded-lg overflow-hidden shadow-lg">
                {livePreviewUrl ? (
                  <img
                    src={livePreviewUrl}
                    alt="Live preview from Docker (what is being recorded)"
                    className="w-full h-full object-contain bg-black"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-muted text-muted-foreground">
                    <Loader2 className="h-12 w-12 animate-spin" />
                    <p className="text-sm">Preview from Docker will appear here once the worker starts.</p>
                  </div>
                )}
                <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent p-3">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-md bg-primary/90 px-2.5 py-1 text-sm font-medium text-primary-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Recording
                    </span>
                    {selectedVideo.createdAt && (
                      <span className="text-xs text-white/80">
                        {Math.floor((Date.now() - new Date(selectedVideo.createdAt).getTime()) / 1000)}s
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => handleStopRecording(e, selectedVideo)}
                      disabled={stopping || cancelling}
                      className="gap-1.5"
                    >
                      <Square className="h-3.5 w-3.5" />
                      {stopping ? "Stopping..." : "Stop & Save"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => handleCancelRecording(e, selectedVideo)}
                      disabled={cancelling || stopping}
                      className="gap-1.5"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {cancelling ? "Cancelling..." : "Cancel"}
                    </Button>
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                Live preview from the Docker worker (what Chromium in Linux is recording). Video + audio will be saved when the replay ends or after Stop.
              </p>
            </div>
          ) : selectedVideo?.status === "cancelled" ? (
            <div className="w-full max-w-md text-center">
              <XCircle className="h-12 w-12 mx-auto mb-2 opacity-50 text-muted-foreground" />
              <p className="font-medium">Recording cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                The recording was stopped before completion.
              </p>
            </div>
          ) : selectedVideo?.status === "failed" ? (
            <div className="w-full max-w-md text-center">
              <Video className="h-12 w-12 mx-auto mb-2 opacity-50 text-destructive" />
              <p className="font-medium">Recording failed</p>
              <p className="text-sm text-muted-foreground mt-1">
                {selectedVideo.metadata?.error ?? "Unknown error"}
              </p>
            </div>
          ) : (selectedVideo?.playUrl ?? selectedVideo?.sourceUrl) ? (
            <div className="w-full max-w-4xl aspect-video bg-black rounded-lg overflow-hidden shadow-lg">
              <video
                src={selectedVideo!.playUrl ?? selectedVideo!.sourceUrl}
                controls
                className="w-full h-full object-contain"
              />
            </div>
          ) : selectedVideo ? (
            <div className="text-center text-muted-foreground">
              <Video className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No preview</p>
            </div>
          ) : (
            <div
              className="w-full max-w-md rounded-lg border-2 border-dashed border-muted-foreground/25 p-12 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
              onClick={handleAddClick}
            >
              <Plus className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground mb-2">No video selected</p>
              <p className="text-sm text-muted-foreground">
                Click «+» on the left or here to add a video
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
