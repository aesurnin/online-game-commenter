import { useRef, useState, useEffect, useCallback } from "react"
import { Player } from "@remotion/player"
import { SceneComposition, type RemotionSceneProps } from "./SceneComposition"

const DEFAULT_WIDTH = 1920
const DEFAULT_HEIGHT = 1080
const DEFAULT_FPS = 30
const DEFAULT_DURATION = 30 * 30

interface RemotionPreviewProps {
  scene: RemotionSceneProps["scene"]
  className?: string
}

export function RemotionPreview({ scene, className }: RemotionPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [playerSize, setPlayerSize] = useState<{ w: number; h: number } | null>(null)

  const compW = scene?.width ?? DEFAULT_WIDTH
  const compH = scene?.height ?? DEFAULT_HEIGHT
  const fps = scene?.fps ?? DEFAULT_FPS
  const durationInFrames =
    scene?.durationInFrames ??
    (scene?.clips?.length
      ? Math.max(...(scene.clips?.map((c) => c.from + c.durationInFrames) ?? [0]))
      : DEFAULT_DURATION)
  const ratio = compW / compH

  const recalc = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const availW = el.clientWidth
    const maxH = window.innerHeight * 0.7

    let w = availW
    let h = availW / ratio
    if (h > maxH) {
      h = maxH
      w = maxH * ratio
    }
    setPlayerSize({ w: Math.round(w), h: Math.round(h) })
  }, [ratio])

  useEffect(() => {
    recalc()
    const id = requestAnimationFrame(() => recalc())
    const ro = new ResizeObserver(recalc)
    if (containerRef.current) ro.observe(containerRef.current)
    window.addEventListener("resize", recalc)
    return () => {
      cancelAnimationFrame(id)
      ro.disconnect()
      window.removeEventListener("resize", recalc)
    }
  }, [recalc])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", display: "flex", justifyContent: "center" }}
    >
      {playerSize && (
        <Player
          component={SceneComposition}
          inputProps={{ scene } as RemotionSceneProps}
          durationInFrames={durationInFrames}
          compositionWidth={compW}
          compositionHeight={compH}
          fps={fps}
          controls
          numberOfSharedAudioTags={8}
          style={{ width: playerSize.w, height: playerSize.h }}
        />
      )}
    </div>
  )
}
