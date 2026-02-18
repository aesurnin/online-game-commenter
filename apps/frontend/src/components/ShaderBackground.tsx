import { useEffect, useRef } from "react"

const VERTEX_SHADER = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;
  uniform vec3 colorA;
  uniform vec3 colorB;
  uniform vec3 colorC;
  uniform float vignetteStrength;

  // Hash-based pseudo-random for organic noise
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    vec2 shift = vec2(100.0);
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p = rot * p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec2 q = vec2(0.0);
    q.x = fbm(uv * 2.0 + time * 0.15);
    q.y = fbm(uv * 2.0 + vec2(1.0) + time * 0.12);

    vec2 r = vec2(0.0);
    r.x = fbm(uv + 1.0 * q + vec2(0.7 * time, 0.3 * time));
    r.y = fbm(uv + 1.0 * q + vec2(0.3 * time, 0.7 * time));

    float f = fbm(uv + 2.0 * r);

    // Flowing gradient blend
    float blend = smoothstep(0.0, 0.6, f);
    vec3 col = mix(colorA, colorB, blend);
    col = mix(col, colorC, smoothstep(0.4, 0.9, r.x));

    // Soft vignette (only in dark mode)
    vec2 vignette = uv - 0.5;
    float vig = 1.0 - dot(vignette, vignette) * 1.2 * vignetteStrength;
    col *= vig;

    gl_FragColor = vec4(col, 0.9);
  }
`

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error("Shader compile error:", gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

type ShaderBackgroundProps = {
  className?: string
  dark?: boolean
}

export function ShaderBackground({ className = "", dark = false }: ShaderBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false })
    if (!gl) return

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vertexShader || !fragmentShader) return

    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertexShader)
    gl.attachShader(program, fragmentShader)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(program))
      return
    }

    const positionLoc = gl.getAttribLocation(program, "position")
    const resolutionLoc = gl.getUniformLocation(program, "resolution")
    const timeLoc = gl.getUniformLocation(program, "time")
    const colorALoc = gl.getUniformLocation(program, "colorA")
    const colorBLoc = gl.getUniformLocation(program, "colorB")
    const colorCLoc = gl.getUniformLocation(program, "colorC")
    const vignetteLoc = gl.getUniformLocation(program, "vignetteStrength")

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1])
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      gl.viewport(0, 0, canvas.width, canvas.height)
    }

    resize()
    window.addEventListener("resize", resize)

    // Theme-aware colors: dark = deep blue, light = bright cloud blue-white (no dark tones)
    const colors = dark
      ? {
          colorA: [0.06, 0.08, 0.14] as [number, number, number],
          colorB: [0.1, 0.08, 0.2] as [number, number, number],
          colorC: [0.08, 0.12, 0.22] as [number, number, number],
        }
      : {
          colorA: [1.0, 1.0, 1.0] as [number, number, number],
          colorB: [0.98, 0.99, 1.0] as [number, number, number],
          colorC: [0.92, 0.96, 1.0] as [number, number, number],
        }

    let animationId: number
    const startTime = performance.now() / 1000

    const render = () => {
      const time = performance.now() / 1000 - startTime

      gl.useProgram(program)
      gl.uniform2f(resolutionLoc, canvas!.width, canvas!.height)
      gl.uniform1f(timeLoc, time)
      gl.uniform3fv(colorALoc, colors.colorA)
      gl.uniform3fv(colorBLoc, colors.colorB)
      gl.uniform3fv(colorCLoc, colors.colorC)
      gl.uniform1f(vignetteLoc, dark ? 1.0 : 0.0)

      gl.enableVertexAttribArray(positionLoc)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0)

      gl.drawArrays(gl.TRIANGLES, 0, 6)

      animationId = requestAnimationFrame(render)
    }

    render()

    return () => {
      window.removeEventListener("resize", resize)
      cancelAnimationFrame(animationId)
      gl.deleteProgram(program)
      gl.deleteShader(vertexShader)
      gl.deleteShader(fragmentShader)
      gl.deleteBuffer(buffer)
    }
  }, [dark])

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full pointer-events-none ${className}`}
      style={{ opacity: 1 }}
    />
  )
}
