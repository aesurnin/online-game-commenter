import { useState, useCallback, useEffect } from "react"
import ReactMarkdown from "react-markdown"
import { Button } from "@/components/ui/button"
import type { PreviewAssetState, PreviewAssetMetadata } from "@/contexts/PreviewVideoContext"

function formatSize(bytes?: number): string {
  if (bytes == null) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso?: string): string {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })
  } catch {
    return iso
  }
}

function formatDuration(sec?: number): string {
  if (sec == null || sec < 0) return "—"
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, "0")}`
}

function MetadataPanel({ metadata, openUrl }: { metadata?: PreviewAssetMetadata; openUrl?: string }) {
  if (!metadata && !openUrl) return null
  const hasAny = metadata && (
    metadata.size != null ||
    metadata.lastModified ||
    metadata.contentType ||
    metadata.duration != null ||
    (metadata.width != null && metadata.height != null) ||
    metadata.key
  )
  if (!hasAny && !openUrl) return null
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
      <div className="font-medium text-xs uppercase tracking-wider text-muted-foreground">Metadata</div>
      <div className="grid gap-x-4 gap-y-1 text-xs">
        {metadata?.size != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Size</span>
            <span>{formatSize(metadata.size)}</span>
          </div>
        )}
        {metadata?.contentType && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Type</span>
            <span>{metadata.contentType}</span>
          </div>
        )}
        {metadata?.duration != null && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Duration</span>
            <span>{formatDuration(metadata.duration)}</span>
          </div>
        )}
        {(metadata?.width != null || metadata?.height != null) && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Dimensions</span>
            <span>
              {metadata.width ?? "?"} × {metadata.height ?? "?"}
            </span>
          </div>
        )}
        {metadata?.lastModified && (
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Modified</span>
            <span>{formatDate(metadata.lastModified)}</span>
          </div>
        )}
        {metadata?.key && (
          <div className="pt-1">
            <span className="block text-muted-foreground mb-0.5">Key</span>
            <code className="block text-[10px] break-all bg-muted/50 rounded px-1.5 py-1">{metadata.key}</code>
          </div>
        )}
      </div>
      {openUrl && (
        <div className="pt-2 border-t">
          <a
            href={openUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            Open in new tab
          </a>
        </div>
      )}
    </div>
  )
}

type UniversalViewerProps = {
  asset: PreviewAssetState
  onClose: () => void
}

function getFullUrl(url: string): string {
  if (url.startsWith("http")) return url
  return `${window.location.origin}${url.startsWith("/") ? "" : "/"}${url}`
}

function isTextContentType(contentType: string, url: string): boolean {
  if (contentType.startsWith("text/")) return true
  const u = url.split("?")[0].toLowerCase()
  return u.endsWith(".txt") || u.endsWith(".md")
}

function isMarkdownContentType(contentType: string, url: string): boolean {
  if (contentType === "text/markdown") return true
  const u = url.split("?")[0].toLowerCase()
  return u.endsWith(".md")
}

function TextContentPreview({ url, contentType }: { url: string; contentType: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isMarkdown = isMarkdownContentType(contentType, url)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setText(null)
    const fetchUrl = url.startsWith("http") || url.startsWith("/") ? url : getFullUrl(url)
    fetch(fetchUrl, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((body) => {
        if (!cancelled) setText(body)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [url])

  if (error) {
    return (
      <div className="p-4 text-destructive text-sm">
        Failed to load: {error}
      </div>
    )
  }
  if (text === null) {
    return (
      <div className="p-8 text-center text-muted-foreground text-sm">
        Loading…
      </div>
    )
  }
  return (
    <div className="p-4 flex-1 min-h-0 overflow-auto bg-background text-foreground">
      {isMarkdown ? (
        <article className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown
            components={{
              pre: ({ children }) => <pre className="whitespace-pre-wrap break-words">{children}</pre>,
            }}
          >
            {text}
          </ReactMarkdown>
        </article>
      ) : (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words m-0">
          {text}
        </pre>
      )}
    </div>
  )
}

export function UniversalViewer({ asset, onClose }: UniversalViewerProps) {
  const [mediaMetadata, setMediaMetadata] = useState<Partial<PreviewAssetMetadata>>({})

  const handleVideoMetadata = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    setMediaMetadata({
      duration: v.duration,
      width: v.videoWidth,
      height: v.videoHeight,
    })
  }, [])

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    setMediaMetadata({ width: img.naturalWidth, height: img.naturalHeight })
  }, [])

  if (!asset?.url) return null

  const contentType = asset.contentType ?? ""
  const isVideo = contentType.startsWith("video/")
  const isImage = contentType.startsWith("image/")
  const isText = isTextContentType(contentType, asset.url)
  const mergedMetadata = { ...asset.metadata, ...mediaMetadata }
  const fullUrl = getFullUrl(asset.url)

  const header = (
    <div className="flex items-center justify-between p-3 shrink-0 bg-muted/30 rounded-t-lg">
      <span className="text-sm font-medium truncate">
        {asset.label ?? "Preview"}
      </span>
      <Button variant="secondary" size="sm" onClick={onClose}>
        Back to original
      </Button>
    </div>
  )

  if (isText) {
    return (
      <div className="w-full max-w-4xl space-y-3">
        <div className="rounded-lg overflow-hidden shadow-lg border bg-background flex flex-col max-h-[75vh]">
          {header}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <TextContentPreview url={asset.url} contentType={contentType || "text/plain"} />
          </div>
        </div>
        <MetadataPanel metadata={mergedMetadata} openUrl={fullUrl} />
      </div>
    )
  }

  return (
    <div className="w-full max-w-4xl space-y-3">
      <div className="relative bg-black rounded-lg overflow-hidden shadow-lg">
        <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between p-3 bg-gradient-to-b from-black/80 to-transparent">
          <span className="text-sm font-medium text-white truncate">
            {asset.label ?? "Preview"}
          </span>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Back to original
          </Button>
        </div>
        <div className="aspect-video flex items-center justify-center bg-black min-h-[200px]">
          {isVideo && (
            <video
              src={asset.url}
              controls
              className="w-full h-full object-contain max-h-[70vh]"
              onLoadedMetadata={handleVideoMetadata}
            />
          )}
          {isImage && (
            <img
              src={asset.url}
              alt={asset.label ?? "Preview"}
              className="max-w-full max-h-[70vh] object-contain"
              onLoad={handleImageLoad}
            />
          )}
          {!isVideo && !isImage && (
            <div className="p-8 text-center text-muted-foreground">
              <p className="text-sm">Preview not available for this file type</p>
              <p className="text-xs mt-1">{contentType || "Unknown type"}</p>
              <a
                href={asset.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline mt-2 inline-block"
              >
                Open in new tab
              </a>
            </div>
          )}
        </div>
      </div>
      <MetadataPanel metadata={mergedMetadata} openUrl={fullUrl} />
    </div>
  )
}
