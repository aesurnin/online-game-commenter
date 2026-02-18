import { createContext, useContext, useState, type ReactNode } from "react"

export type PreviewAssetMetadata = {
  size?: number
  lastModified?: string
  key?: string
  contentType?: string
  duration?: number
  width?: number
  height?: number
  /** Token usage from workflow module metadata (e.g. llm-agent) */
  tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  /** Estimated cost in USD (from OpenRouter pricing) */
  costUsd?: number
  /** Execution time in milliseconds */
  executionTimeMs?: number
}

export type PreviewAssetState = {
  url: string
  label?: string
  contentType?: string
  metadata?: PreviewAssetMetadata
  /** When set, show Remotion Player instead of video (for video.render.remotion module) */
  remotionSceneUrl?: string
  /** When set, show Remotion Player directly with inline scene data (no URL fetch needed) */
  inlineRemotionScene?: Record<string, unknown>
} | null

const PreviewVideoContext = createContext<{
  previewVideo: PreviewAssetState
  setPreviewVideo: (v: PreviewAssetState) => void
} | null>(null)

export function PreviewVideoProvider({ children }: { children: ReactNode }) {
  const [previewVideo, setPreviewVideo] = useState<PreviewAssetState>(null)
  return (
    <PreviewVideoContext.Provider value={{ previewVideo, setPreviewVideo }}>
      {children}
    </PreviewVideoContext.Provider>
  )
}

export function usePreviewVideo() {
  const ctx = useContext(PreviewVideoContext)
  if (!ctx) throw new Error("usePreviewVideo must be used within PreviewVideoProvider")
  return ctx
}
