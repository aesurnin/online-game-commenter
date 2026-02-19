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
  uniform sampler2D asciiTex;
  uniform float charsPerRow;
  uniform float totalChars;
  uniform vec2 charSize;
  uniform float isDark;

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
    float v = 0.0, a = 0.5;
    vec2 shift = vec2(100.0);
    mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
    for (int i = 0; i < 6; i++) {
      v += a * noise(p);
      p = rot * p * 2.0 + shift;
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / resolution.xy;
    vec2 aspect = vec2(resolution.x / resolution.y, 1.0);

    // Cell grid
    vec2 cellCount = floor(resolution / charSize);
    vec2 cellUV = floor(uv * cellCount) / cellCount;
    vec2 inCell = fract(uv * cellCount);

    float t = time * 0.15;

    // === WAVE LAYERS: self-flowing, drifting on their own ===
    float wave1 = sin(cellUV.y * 10.0 + t * 3.0 + cellUV.x * 2.0) * 0.5 + 0.5;
    wave1 += sin(cellUV.y * 7.0 - t * 2.2 + cellUV.x * 4.0) * 0.35;

    float wave2 = sin(cellUV.x * 9.0 + t * 2.5 + cellUV.y * 3.0) * 0.5 + 0.5;
    wave2 += sin(cellUV.x * 5.0 - t * 1.8 + cellUV.y * 2.0) * 0.3;

    float wave4 = sin((cellUV.x + cellUV.y) * 8.0 + t * 2.8) * 0.5 + 0.5;
    wave4 += sin((cellUV.x - cellUV.y) * 6.0 - t * 1.5) * 0.25;

    float distToCenter = length((cellUV - 0.5) * aspect);
    float ripple = sin(distToCenter * 12.0 - t * 2.5) * 0.5 + 0.5;
    ripple *= 0.55;

    // Base noise: organic flow
    float deep = fbm(cellUV * 2.0 + t * 0.8);
    float mid = fbm(cellUV * 4.0 + vec2(1.7, 9.2) + t * 1.2);

    // === Composite ===
    float brightness = 0.0;
    brightness += wave1 * 0.28;
    brightness += wave2 * 0.26;
    brightness += wave4 * 0.22;
    brightness += ripple * 0.12;
    brightness += deep * 0.06;
    brightness += mid * 0.04;

    brightness = smoothstep(0.1, 0.9, brightness);
    brightness = clamp(brightness, 0.0, 1.0);

    // Per-cell jitter
    float cellRand = hash(floor(uv * cellCount));
    brightness = clamp(brightness + (cellRand - 0.5) * 0.05, 0.0, 1.0);

    // === ASCII lookup ===
    float charIdx = floor(brightness * (totalChars - 1.0));
    float col = mod(charIdx, charsPerRow);
    float row = floor(charIdx / charsPerRow);
    float totalRows = ceil(totalChars / charsPerRow);
    vec2 atlasUV = vec2(
      (col + inCell.x) / charsPerRow,
      1.0 - (row + 1.0 - inCell.y) / totalRows
    );
    float charAlpha = texture2D(asciiTex, atlasUV).r;

    // === 1. Symbols disappear in brightest areas ===
    float fadeOut = 1.0 - smoothstep(0.75, 0.95, brightness);
    charAlpha *= fadeOut;

    // === 2. Color gradation: dark → light (clear gradient) ===
    // Dark theme: darkest (bg) → dark → mid → bright → lightest (symbols)
    vec3 dkDarkest = vec3(0.02, 0.03, 0.06);
    vec3 dkDark    = vec3(0.06, 0.12, 0.22);
    vec3 dkMid     = vec3(0.12, 0.28, 0.48);
    vec3 dkBright  = vec3(0.25, 0.55, 0.82);
    vec3 dkLight   = vec3(0.45, 0.75, 1.00);

    // Light theme: lightest (bg) → light → mid → dark → darkest (symbols)
    vec3 ltLightest = vec3(0.98, 0.99, 1.00);
    vec3 ltLight    = vec3(0.85, 0.88, 0.94);
    vec3 ltMid      = vec3(0.55, 0.62, 0.78);
    vec3 ltDark     = vec3(0.32, 0.40, 0.62);
    vec3 ltDarkest  = vec3(0.18, 0.25, 0.48);

    vec3 darkest = mix(ltLightest, dkDarkest, isDark);
    vec3 dark    = mix(ltLight,    dkDark,    isDark);
    vec3 midC    = mix(ltMid,     dkMid,     isDark);
    vec3 bright  = mix(ltDark,    dkBright,  isDark);
    vec3 light   = mix(ltDarkest, dkLight,   isDark);

    // Smooth multi-stop gradient: brightness 0 = darkest, 1 = lightest
    vec3 fg = darkest;
    fg = mix(fg, dark,   smoothstep(0.0,  0.25, brightness));
    fg = mix(fg, midC,   smoothstep(0.25, 0.50, brightness));
    fg = mix(fg, bright, smoothstep(0.50, 0.75, brightness));
    fg = mix(fg, light,  smoothstep(0.75, 1.0,  brightness));

    // === Scanlines ===
    float scanline = sin(gl_FragCoord.y * 1.5) * 0.5 + 0.5;
    scanline = mix(1.0, 0.94 + 0.06 * scanline, isDark * 0.7);

    // === Final composite ===
    vec3 color = mix(darkest, fg, charAlpha);
    color *= scanline;

    // Vignette with shape variation
    vec2 vig = (uv - 0.5) * vec2(1.1, 1.0);
    float vigAmount = 1.0 - dot(vig, vig) * (0.5 + 0.9 * isDark);
    vigAmount = smoothstep(0.0, 1.0, vigAmount);
    color *= vigAmount;

    gl_FragColor = vec4(color, 0.95);
  }
`

const ASCII_CHARS = " .'`^\",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"

function createAsciiTexture(gl: WebGLRenderingContext): {
  texture: WebGLTexture | null
  charsPerRow: number
  totalChars: number
  charW: number
  charH: number
} {
  const chars = ASCII_CHARS
  const fontSize = 24
  const font = `bold ${fontSize}px "Courier New", "Consolas", monospace`

  const measure = document.createElement("canvas")
  const mctx = measure.getContext("2d")!
  mctx.font = font
  const metrics = mctx.measureText("M")
  const charW = Math.ceil(metrics.width)
  const charH = fontSize + 4

  const cols = chars.length
  const atlasW = cols * charW
  const atlasH = charH

  const canvas = document.createElement("canvas")
  canvas.width = atlasW
  canvas.height = atlasH
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "black"
  ctx.fillRect(0, 0, atlasW, atlasH)
  ctx.fillStyle = "white"
  ctx.font = font
  ctx.textBaseline = "top"

  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], i * charW, 2)
  }

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  return { texture, charsPerRow: cols, totalChars: chars.length, charW, charH }
}

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
    const asciiTexLoc = gl.getUniformLocation(program, "asciiTex")
    const charsPerRowLoc = gl.getUniformLocation(program, "charsPerRow")
    const totalCharsLoc = gl.getUniformLocation(program, "totalChars")
    const charSizeLoc = gl.getUniformLocation(program, "charSize")
    const isDarkLoc = gl.getUniformLocation(program, "isDark")

    const atlas = createAsciiTexture(gl)

    const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1])
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const cellScale = 0.5

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      gl.viewport(0, 0, canvas.width, canvas.height)
    }

    resize()
    window.addEventListener("resize", resize)

    let animationId: number
    const startTime = performance.now() / 1000

    const render = () => {
      const time = performance.now() / 1000 - startTime

      gl.useProgram(program)
      gl.uniform2f(resolutionLoc, canvas.width, canvas.height)
      gl.uniform1f(timeLoc, time)
      gl.uniform1i(asciiTexLoc, 0)
      gl.uniform1f(charsPerRowLoc, atlas.charsPerRow)
      gl.uniform1f(totalCharsLoc, atlas.totalChars)
      gl.uniform2f(charSizeLoc, atlas.charW * cellScale * dpr, atlas.charH * cellScale * dpr)
      gl.uniform1f(isDarkLoc, dark ? 1.0 : 0.0)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, atlas.texture)

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
      gl.deleteTexture(atlas.texture)
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
