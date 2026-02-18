import { useState, useEffect } from "react"
import { File, ChevronDown, ChevronRight, ExternalLink, Loader2, Folder, Trash2 } from "lucide-react"
import { useSelectedVideo } from "@/contexts/SelectedVideoContext"
import { usePreviewVideo } from "@/contexts/PreviewVideoContext"

type Asset = {
  key: string
  shortKey: string
  size?: number
  lastModified?: string
  contentType?: string
  previewUrl?: string
}

function formatSize(bytes?: number): string {
  if (bytes == null) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    })
  } catch {
    return iso
  }
}

type WorkflowCacheFolder = { folderName: string; moduleId: string }

export function AssetsPanel({ hideHeader }: { hideHeader?: boolean } = {}) {
  const { selectedVideo, assetsRefreshTrigger, refreshAssets } = useSelectedVideo()
  const { setPreviewVideo } = usePreviewVideo()
  const [assets, setAssets] = useState<Asset[]>([])
  const [workflowCache, setWorkflowCache] = useState<WorkflowCacheFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const projectId = selectedVideo?.projectId
  const videoId = selectedVideo?.videoId

  useEffect(() => {
    if (!projectId || !videoId) {
      setAssets([])
      setWorkflowCache([])
      return
    }
    setLoading(true)
    Promise.all([
      fetch(`/api/projects/${projectId}/videos/${videoId}/assets`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { assets: [] }))
        .then((data) => data.assets ?? []),
      fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : { workflowCache: [] }))
        .then((data) => data.workflowCache ?? []),
    ])
      .then(([a, w]) => {
        setAssets(a)
        setWorkflowCache(w)
      })
      .catch(() => {
        setAssets([])
        setWorkflowCache([])
      })
      .finally(() => setLoading(false))
  }, [projectId, videoId, assetsRefreshTrigger])

  if (!projectId || !videoId) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        Select a video to view assets
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {!hideHeader && (
        <div className="px-3 pt-3 pb-2 border-b shrink-0">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Assets
          </span>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : assets.length === 0 && workflowCache.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">No assets found</p>
        ) : (
          <div className="space-y-1">
            {workflowCache.length > 0 && (
              <div className="mb-2">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1">
                  Workflow cache
                </span>
                {workflowCache.map((folder) => (
                  <WorkflowCacheRow
                    key={folder.moduleId}
                    folder={folder}
                    projectId={projectId}
                    videoId={videoId}
                    onDeleted={refreshAssets}
                    onPreview={setPreviewVideo}
                  />
                ))}
              </div>
            )}
            {assets.length > 0 && (
              <>
                {workflowCache.length > 0 && (
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-1 block mt-2">
                    R2 assets
                  </span>
                )}
                {assets.map((asset) => (
                  <AssetRow
                    key={asset.key}
                    asset={asset}
                    expanded={expandedKey === asset.key}
                    onToggle={() => setExpandedKey((k) => (k === asset.key ? null : asset.key))}
                    onPreview={() =>
                      asset.previewUrl &&
                      setPreviewVideo({
                        url: asset.previewUrl,
                        label: asset.shortKey,
                        contentType: asset.contentType,
                        metadata: {
                          size: asset.size,
                          lastModified: asset.lastModified,
                          key: asset.key,
                          contentType: asset.contentType,
                        },
                      })
                    }
                    onDelete={() => {
                      if (!confirm(`Delete "${asset.shortKey}"? This cannot be undone.`)) return
                      fetch(`/api/projects/${projectId}/videos/${videoId}/assets`, {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: JSON.stringify({ key: asset.key }),
                      })
                        .then((r) => r.ok && refreshAssets())
                        .catch(() => {})
                    }}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const PREVIEWABLE_EXT = /\.(mp4|webm|mov|mkv|jpg|jpeg|png|gif|webp|mp3|wav|ogg|m4a|txt|md)$/i

function getContentTypeFromExt(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ""
  const map: Record<string, string> = {
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".txt": "text/plain", ".md": "text/markdown",
  }
  return map[ext] ?? "application/octet-stream"
}

type CacheEntry = { name: string; type: "file" | "dir"; size?: number }

function WorkflowCacheRow({
  folder,
  projectId,
  videoId,
  onDeleted,
  onPreview,
}: {
  folder: WorkflowCacheFolder
  projectId: string
  videoId: string
  onDeleted: () => void
  onPreview: (v: { url: string; label: string; contentType: string; metadata?: Record<string, unknown> }) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [entries, setEntries] = useState<CacheEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [pathStack, setPathStack] = useState<string[]>([])

  const currentPath = pathStack.length > 0 ? pathStack.join("/") : undefined

  useEffect(() => {
    if (!expanded || !projectId || !videoId) return
    setLoading(true)
    const url = currentPath
      ? `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/contents?path=${encodeURIComponent(currentPath)}`
      : `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/contents`
    fetch(url, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { entries: [] }))
      .then((data) => setEntries(data.entries ?? []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [expanded, projectId, videoId, folder.folderName, currentPath])

  const handleDelete = () => {
    if (!confirm(`Delete workflow cache folder "${folder.folderName}"? This cannot be undone.`)) return
    setDeleting(true)
    fetch(`/api/projects/${projectId}/videos/${videoId}/workflow-cache/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ moduleIds: [folder.moduleId] }),
    })
      .then((r) => r.ok && onDeleted())
      .finally(() => setDeleting(false))
  }

  const goInto = (name: string) => {
    setPathStack((prev) => [...prev, name])
  }

  const goUp = () => {
    setPathStack((prev) => prev.slice(0, -1))
  }

  const goToRoot = () => {
    setPathStack([])
  }

  return (
    <div className="rounded border bg-panel-3 mt-1 overflow-hidden">
      <div
        className="flex items-center gap-2 px-2 py-1.5 group cursor-pointer hover:bg-muted/50"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-mono text-xs truncate" title={folder.folderName}>
          {folder.folderName}
        </span>
        <button
          className="shrink-0 p-1 rounded hover:bg-destructive/20 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
          onClick={(e) => {
            e.stopPropagation()
            handleDelete()
          }}
          disabled={deleting}
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="border-t bg-panel-2 px-2 py-1.5 text-xs">
          {pathStack.length > 0 && (
            <div className="flex items-center gap-1 mb-2 flex-wrap">
              <button
                className="text-primary hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  goToRoot()
                }}
              >
                {folder.folderName}
              </button>
              {pathStack.map((seg, i) => (
                <span key={i} className="flex items-center gap-1">
                  <span className="text-muted-foreground">/</span>
                  <button
                    className="text-primary hover:underline"
                    onClick={(e) => {
                      e.stopPropagation()
                      setPathStack((prev) => prev.slice(0, i + 1))
                    }}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Loading…</span>
            </div>
          ) : entries.length === 0 ? (
            <p className="text-muted-foreground py-2">Empty</p>
          ) : (
            <ul className="space-y-0.5 max-h-48 overflow-y-auto">
              {pathStack.length > 0 && (
                <li>
                  <button
                    className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5"
                    onClick={(e) => {
                      e.stopPropagation()
                      goUp()
                    }}
                  >
                    <Folder className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">..</span>
                  </button>
                </li>
              )}
              {entries.map((entry) => (
                <li key={entry.name}>
                  {entry.type === "dir" ? (
                    <button
                      className="flex items-center gap-2 w-full text-left hover:bg-muted/50 rounded px-1.5 py-0.5 -ml-1.5"
                      onClick={(e) => {
                        e.stopPropagation()
                        goInto(entry.name)
                      }}
                    >
                      <Folder className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 px-1.5 py-0.5 -ml-1.5 group/row">
                      <File className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{entry.name}</span>
                      {entry.size != null && (
                        <span className="text-muted-foreground shrink-0">{formatSize(entry.size)}</span>
                      )}
                      {PREVIEWABLE_EXT.test(entry.name) && (
                        <button
                          className="shrink-0 p-1 rounded hover:bg-muted opacity-0 group-hover/row:opacity-100 transition-opacity"
                          onClick={(e) => {
                            e.stopPropagation()
                            const relPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
                            const url = `/api/projects/${projectId}/videos/${videoId}/workflow-cache/${encodeURIComponent(folder.folderName)}/file?path=${encodeURIComponent(relPath)}`
                            onPreview({
                              url,
                              label: `${folder.folderName}/${relPath}`,
                              contentType: getContentTypeFromExt(entry.name),
                              metadata: { size: entry.size },
                            })
                          }}
                          title="Preview"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function AssetRow({
  asset,
  expanded,
  onToggle,
  onPreview,
  onDelete,
}: {
  asset: Asset
  expanded: boolean
  onToggle: () => void
  onPreview: () => void
  onDelete: () => void
}) {
  return (
    <div className="rounded border bg-panel-3 text-sm">
      <div
        className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-muted/50 group"
        onClick={onToggle}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate min-w-0 font-mono text-xs" title={asset.key}>
          {asset.shortKey}
        </span>
        {asset.previewUrl && (
          <button
            className="shrink-0 p-1 rounded hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation()
              onPreview()
            }}
            title="Preview"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
        )}
        <button
          className="shrink-0 p-1 rounded hover:bg-destructive/20 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
      {expanded && (
        <div className="px-2 pb-2 pt-0 space-y-1 text-xs text-muted-foreground border-t">
          <div className="flex justify-between gap-4">
            <span>Size</span>
            <span>{formatSize(asset.size)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Modified</span>
            <span>{formatDate(asset.lastModified)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span>Type</span>
            <span>{asset.contentType ?? "—"}</span>
          </div>
          <div className="pt-1">
            <span className="block text-muted-foreground/70 mb-0.5">Full key</span>
            <code className="block text-[10px] break-all bg-muted/50 rounded px-1.5 py-1">
              {asset.key}
            </code>
          </div>
          {asset.previewUrl && (
            <div className="mt-2 flex gap-3">
              <button className="text-xs text-primary hover:underline" onClick={onPreview}>
                Preview in main area
              </button>
              <a
                href={asset.previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                Open in new tab
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
