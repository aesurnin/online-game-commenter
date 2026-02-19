import React from "react"
import { AbsoluteFill, Audio, Sequence, Video, useCurrentFrame, useVideoConfig } from "remotion"

/** Video clip in RemotionScene JSON schema */
export interface SceneVideoClip {
  type: "video"
  src: string
  from: number
  durationInFrames: number
  layout?: "fill" | "contain" | "cover"
  volume?: number
}

/** Text overlay clip in RemotionScene JSON schema */
export interface SceneTextClip {
  type: "text"
  text: string
  from: number
  durationInFrames: number
  position?: "bottom" | "top" | "center"
  fontSize?: number
  color?: string
}

/** Audio clip in RemotionScene JSON schema */
export interface SceneAudioClip {
  type: "audio"
  src: string
  from: number
  durationInFrames: number
  volume?: number
}

export type SceneClip = SceneVideoClip | SceneTextClip | SceneAudioClip

export interface RemotionSceneProps {
  scene?: {
    width?: number
    height?: number
    fps?: number
    durationInFrames?: number
    clips?: SceneClip[]
    backgroundColor?: string
    /** When true, render first video clip as scaled + blurred background */
    blurredBackground?: boolean
    /** Blur radius in px for background (default 40) */
    blurredBackgroundRadius?: number
    /** Scale factor for background video, >1 = zoomed in (default 1.2) */
    blurredBackgroundScale?: number
    /** Volume for blurred background video (0 to 1, default 0) */
    blurredBackgroundVolume?: number
  }
}

export const SceneComposition: React.FC<RemotionSceneProps> = ({ scene }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const clips = scene?.clips ?? []
  const backgroundColor = scene?.backgroundColor ?? "#0a0a0a"
  const blurredBg = scene?.blurredBackground ?? false
  const blurRadius = scene?.blurredBackgroundRadius ?? 40
  const blurScale = scene?.blurredBackgroundScale ?? 1.2
  const blurVolume = scene?.blurredBackgroundVolume ?? 0

  const firstVideoClip = clips.find((c) => c.type === "video")

  return (
    <AbsoluteFill style={{ backgroundColor }}>
      {blurredBg && firstVideoClip && (
        <AbsoluteFill style={{ overflow: "hidden" }}>
          <AbsoluteFill
            style={{
              transform: `scale(${blurScale})`,
              filter: `blur(${blurRadius}px)`,
            }}
          >
            <Sequence
              from={firstVideoClip.from}
              durationInFrames={firstVideoClip.durationInFrames}
            >
              <AbsoluteFill>
                <Video
                  src={firstVideoClip.src}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  volume={blurVolume}
                  crossOrigin="anonymous"
                />
              </AbsoluteFill>
            </Sequence>
          </AbsoluteFill>
        </AbsoluteFill>
      )}
      {clips.map((clip, idx) => {
        if (clip.type === "video") {
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <AbsoluteFill
                style={{
                  objectFit: clip.layout ?? "contain",
                }}
              >
                <Video
                  src={clip.src}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: clip.layout ?? "contain",
                  }}
                  volume={clip.volume}
                  crossOrigin="anonymous"
                />
              </AbsoluteFill>
            </Sequence>
          )
        }
        if (clip.type === "text") {
          const pos = clip.position ?? "bottom"
          const posStyle =
            pos === "bottom"
              ? { bottom: 0, left: 0, right: 0, justifyContent: "center" as const }
              : pos === "top"
                ? { top: 0, left: 0, right: 0, justifyContent: "center" as const }
                : { top: "50%", left: 0, right: 0, justifyContent: "center" as const, transform: "translateY(-50%)" }
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <AbsoluteFill
                style={{
                  ...posStyle,
                  display: "flex",
                  alignItems: "center",
                  padding: 24,
                  pointerEvents: "none",
                }}
              >
                <div
                  style={{
                    fontSize: clip.fontSize ?? 48,
                    color: clip.color ?? "#ffffff",
                    textShadow: "0 2px 4px rgba(0,0,0,0.8)",
                    textAlign: "center",
                  }}
                >
                  {clip.text}
                </div>
              </AbsoluteFill>
            </Sequence>
          )
        }
        if (clip.type === "audio") {
          return (
            <Sequence key={idx} from={clip.from} durationInFrames={clip.durationInFrames}>
              <Audio src={clip.src} volume={clip.volume} useWebAudioApi crossOrigin="anonymous" />
            </Sequence>
          )
        }
        return null
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
