import { createContext, useContext, useState, useEffect, type ReactNode } from "react"
import { usePreviewVideo } from "./PreviewVideoContext"

type LiveRemotionState = {
  moduleIndex: number | null
  scene: Record<string, unknown> | null
}

const LiveRemotionContext = createContext<{
  liveRemotion: LiveRemotionState
  setLiveRemotion: (moduleIndex: number | null, scene: Record<string, unknown> | null) => void
} | null>(null)

export function LiveRemotionProvider({ children }: { children: ReactNode }) {
  const { previewVideo } = usePreviewVideo()
  const [liveRemotion, setLiveRemotionState] = useState<LiveRemotionState>({
    moduleIndex: null,
    scene: null,
  })

  useEffect(() => {
    if (!previewVideo || !previewVideo.inlineRemotionScene) {
      setLiveRemotionState({ moduleIndex: null, scene: null })
    }
  }, [previewVideo])

  const setLiveRemotion = (moduleIndex: number | null, scene: Record<string, unknown> | null) => {
    setLiveRemotionState({ moduleIndex, scene })
  }

  return (
    <LiveRemotionContext.Provider value={{ liveRemotion, setLiveRemotion }}>
      {children}
    </LiveRemotionContext.Provider>
  )
}

export function useLiveRemotion() {
  const ctx = useContext(LiveRemotionContext)
  if (!ctx) throw new Error("useLiveRemotion must be used within LiveRemotionProvider")
  return ctx
}
