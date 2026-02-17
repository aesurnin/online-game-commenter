import { createContext, useContext, useState, type ReactNode } from "react"

export type PreviewAssetMetadata = {
  size?: number
  lastModified?: string
  key?: string
  contentType?: string
  duration?: number
  width?: number
  height?: number
}

export type PreviewAssetState = {
  url: string
  label?: string
  contentType?: string
  metadata?: PreviewAssetMetadata
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
