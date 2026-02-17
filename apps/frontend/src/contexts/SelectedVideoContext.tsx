import { createContext, useContext, useState, useCallback, type ReactNode } from "react"

type SelectedVideo = {
  projectId: string
  videoId: string
  sourceUrl?: string | null
  /** Presigned URL for playback */
  playUrl?: string | null
  /** Streaming URL (Range support, prefer for video src) */
  streamUrl?: string | null
} | null

const SelectedVideoContext = createContext<{
  selectedVideo: SelectedVideo
  setSelectedVideo: (v: SelectedVideo) => void
  assetsRefreshTrigger: number
  refreshAssets: () => void
} | null>(null)

export function SelectedVideoProvider({ children }: { children: ReactNode }) {
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo>(null)
  const [assetsRefreshTrigger, setAssetsRefreshTrigger] = useState(0)
  const refreshAssets = useCallback(() => setAssetsRefreshTrigger((n) => n + 1), [])
  return (
    <SelectedVideoContext.Provider
      value={{ selectedVideo, setSelectedVideo, assetsRefreshTrigger, refreshAssets }}
    >
      {children}
    </SelectedVideoContext.Provider>
  )
}

export function useSelectedVideo() {
  const ctx = useContext(SelectedVideoContext)
  if (!ctx) throw new Error("useSelectedVideo must be used within SelectedVideoProvider")
  return ctx
}
