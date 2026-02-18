import React from "react"
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion"

export interface SceneClip {
  type: string
  src: string
  from: number
  durationInFrames: number
  layout?: "fill" | "contain" | "cover"
}

export interface RemotionSceneProps {
  scene?: {
    width?: number
    height?: number
    fps?: number
    durationInFrames?: number
    clips?: SceneClip[]
    backgroundColor?: string
  }
}

export const SceneComposition: React.FC<RemotionSceneProps> = ({ scene }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const clips = scene?.clips ?? []
  const backgroundColor = scene?.backgroundColor ?? "#0a0a0a"

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {clips.map((clip, idx) => {
        if (clip.type !== "video") return null
        return (
          <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
            <AbsoluteFill
              style={{
                objectFit: clip.layout ?? "contain",
              }}
            >
              <OffthreadVideo
                src={clip.src}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: clip.layout ?? "contain",
                }}
              />
            </AbsoluteFill>
          </Sequence>
        )
      })}
      {clips.length === 0 && (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            color: "rgba(255,255,255,0.5)",
            fontSize: 24,
          }}
        >
          <div>Scene preview — {Math.floor(frame / fps)}s</div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  )
}
