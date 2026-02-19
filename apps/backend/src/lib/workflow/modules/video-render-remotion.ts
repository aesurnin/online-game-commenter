import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

/** Scene clip from JSON - video, text overlay, or audio */
interface SceneClip {
  type: string;
  src?: string;
  text?: string;
  from: number;
  durationInFrames: number;
  layout?: 'fill' | 'contain' | 'cover';
  position?: 'bottom' | 'top' | 'center';
  fontSize?: number;
  color?: string;
}

/** RemotionScene JSON schema - shared by renderer and player */
interface SceneJson {
  width?: number;
  height?: number;
  fps?: number;
  durationInFrames?: number;
  clips?: SceneClip[];
  backgroundColor?: string;
  blurredBackground?: boolean;
  blurredBackgroundRadius?: number;
  blurredBackgroundScale?: number;
}

export const videoRenderRemotionMeta = {
  type: 'video.render.remotion',
  label: 'Remotion Render',
  description: 'Render a video from a JSON scene definition using Remotion',
  category: 'Video',
  quickParams: [],
  inputSlots: [{ key: 'scene', label: 'Scene JSON', kind: 'text' as const }],
  outputSlots: [{ key: 'video', label: 'Rendered Video', kind: 'video' as const }],
  paramsSchema: [
    {
      key: 'sceneSource',
      label: 'Scene Source',
      type: 'string' as const,
      default: 'variable',
      options: [
        { value: 'variable', label: 'Variable' },
        { value: 'inline', label: 'Inline JSON' },
      ],
    },
    { key: 'sceneJsonInline', label: 'Scene JSON', type: 'json' as const, default: '' },
    {
      key: 'speedMode',
      label: 'Render Speed',
      type: 'string' as const,
      default: 'normal',
      options: [
        { value: 'normal', label: 'Normal (best quality)' },
        { value: 'fast', label: 'Fast (faster encode, HW accel)' },
        { value: 'draft', label: 'Draft (half res, fastest)' },
      ],
    },
  ],
};

function getWorkflowCacheBase(): string {
  const base = process.env.WORKFLOW_CACHE_BASE;
  if (base) return base;
  return path.join(process.cwd(), 'workflow-cache');
}

/** Create a minimal static HTTP server for serving local files */
function createStaticServer(rootDir: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const urlPath = (req.url ?? '/').split('?')[0];
      const decoded = decodeURIComponent(urlPath);
      const normalized = path.normalize(decoded.replace(/^\//, ''));
      if (normalized.includes('..')) {
        res.statusCode = 403;
        res.end();
        return;
      }
      const resolved = path.resolve(rootDir, normalized);
      const rootResolved = path.resolve(rootDir);
      if (!resolved.startsWith(rootResolved)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const ext = path.extname(resolved).toLowerCase();
        const mime: Record<string, string> = {
          '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
          '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
        };
        res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream');
        const stream = (await import('fs')).createReadStream(resolved);
        stream.pipe(res);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/** Convert absolute path to URL-relative path for serving from videoDir */
function toRelativeUrl(absPath: string, videoDir: string): string | null {
  const abs = path.resolve(absPath);
  const root = path.resolve(videoDir);
  if (!abs.startsWith(root)) return null;
  return path.relative(root, abs).replace(/\\/g, '/');
}

/** Resolve workflow-cache API URL to local path for static server */
function resolveWorkflowCacheUrl(apiUrl: string, videoDir: string): string | null {
  const m = apiUrl.match(/\/api\/projects\/([^/]+)\/videos\/([^/]+)\/workflow-cache\/([^/]+)\/file\?path=([^&]+)/);
  if (!m) return null;
  const [, projectId, videoId, folderName, pathParam] = m;
  const decoded = decodeURIComponent(pathParam);
  const localPath = path.join(videoDir, decodeURIComponent(folderName), decoded);
  return localPath;
}

export class VideoRenderRemotionModule implements WorkflowModule {
  readonly meta = videoRenderRemotionMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};

    onLog?.('[RemotionRender] === Module start ===');

    const sceneSource = String(params.sceneSource ?? 'variable');
    let scene: SceneJson;

    /** Extract scene from LLM output format { slots, scene: { clips, ... } } or use as-is if flat */
    function extractScene(parsed: unknown): SceneJson {
      const obj = parsed as Record<string, unknown>;
      const inner = (obj?.scene ?? obj) as SceneJson;
      if (!inner || typeof inner !== 'object') {
        throw new Error('JSON must have a "scene" object or flat scene fields (clips, width, etc.)');
      }
      return inner;
    }

    if (sceneSource === 'inline') {
      const inlineJson = String(params.sceneJsonInline ?? '').trim();
      if (!inlineJson) {
        onLog?.('[RemotionRender] ERROR: Inline scene JSON is empty');
        return { success: false, error: 'Inline scene JSON is empty. Enter scene JSON or switch to Variable mode.' };
      }
      try {
        const parsed = JSON.parse(inlineJson) as unknown;
        scene = extractScene(parsed);
        onLog?.('[RemotionRender] Using inline scene JSON');
      } catch (e) {
        onLog?.(`[RemotionRender] ERROR: Invalid inline JSON: ${e}`);
        return { success: false, error: 'Inline scene JSON is invalid. Please check the syntax.' };
      }
    } else {
      const scenePath = inputPaths['scene'] ?? context.currentTextOutputPath;
      if (!scenePath) {
        onLog?.('[RemotionRender] ERROR: No scene JSON input provided');
        return { success: false, error: 'No scene JSON provided. Connect a text source with scene definition.' };
      }

      try {
        await fs.access(scenePath);
      } catch {
        onLog?.(`[RemotionRender] ERROR: Scene file not found: ${scenePath}`);
        return { success: false, error: `Scene file not found: ${scenePath}` };
      }

      let sceneRaw: string;
      try {
        sceneRaw = await fs.readFile(scenePath, 'utf8');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onLog?.(`[RemotionRender] ERROR: Failed to read scene: ${msg}`);
        return { success: false, error: `Failed to read scene file: ${msg}` };
      }

      try {
        const parsed = JSON.parse(sceneRaw) as unknown;
        scene = extractScene(parsed);
      } catch (e) {
        onLog?.(`[RemotionRender] ERROR: Invalid JSON: ${e}`);
        return { success: false, error: 'Scene file must be valid JSON.' };
      }
    }

    /** Clone for URL modification; original scene has API URLs for scene.json (preview) */
    const sceneForRender = JSON.parse(JSON.stringify(scene)) as SceneJson;

    const width = Math.max(320, Math.min(4096, Number(scene.width ?? 1920)));
    const height = Math.max(240, Math.min(2160, Number(scene.height ?? 1080)));
    const fps = Math.max(1, Math.min(60, Number(scene.fps ?? 30)));
    const speedMode = String(params.speedMode ?? 'normal');

    const cacheBase = getWorkflowCacheBase();
    const videoDir = path.join(cacheBase, context.projectId, context.videoId);

    let staticServer: http.Server | null = null;
    let baseUrl = '';

    if (sceneForRender.clips?.length) {
      onProgress?.(5, 'Starting asset server');
      try {
        const { server, port } = await createStaticServer(videoDir);
        staticServer = server;
        baseUrl = `http://127.0.0.1:${port}/`;
        onLog?.(`[RemotionRender] Asset server on ${baseUrl}`);
      } catch (e) {
        onLog?.(`[RemotionRender] ERROR: Failed to start asset server: ${e}`);
        return { success: false, error: 'Failed to start asset server for assets.' };
      }

      /** Prefer local video variables over remote placeholder URLs (e.g. BigBuckBunny from LLM examples) */
      const videoVars = ['60sec_video', 'video_crop', 'video_1'] as const;
      const fallbackVideoPath = videoVars
        .map((v) => context.variables[v])
        .find((p): p is string => typeof p === 'string' && p.length > 0);

      for (const clip of sceneForRender.clips) {
        let src = clip.type === 'video' ? clip.src : clip.type === 'audio' ? clip.src : undefined;
        if (!src) continue;
        // Resolve workflow-cache API URLs to local path for static server
        if (src.startsWith('/api/projects/') && src.includes('workflow-cache')) {
          const local = resolveWorkflowCacheUrl(src, videoDir);
          if (local) src = local;
        }
        if (clip.type === 'video' && clip.src) {
          if (src.startsWith('http://') || src.startsWith('https://')) {
            if (fallbackVideoPath && (src.includes('BigBuckBunny') || src.includes('sample/'))) {
              onLog?.(`[RemotionRender] Replacing placeholder URL with local video: ${path.basename(fallbackVideoPath)}`);
              clip.src = fallbackVideoPath;
            } else {
              onLog?.(`[RemotionRender] WARNING: Remote URL in clip (may timeout): ${src.slice(0, 80)}...`);
              continue;
            }
          } else {
            const rel = toRelativeUrl(src, videoDir);
            if (rel) {
              clip.src = baseUrl + rel;
            } else {
              onLog?.(`[RemotionRender] WARNING: Clip src not in cache dir, may fail: ${src}`);
            }
          }
        }
        if (clip.type === 'audio' && clip.src) {
          if (!src.startsWith('http')) {
            const rel = toRelativeUrl(src, videoDir);
            if (rel) {
              clip.src = baseUrl + rel;
            } else {
              onLog?.(`[RemotionRender] WARNING: Audio src not in cache dir, may fail: ${src}`);
            }
          } else {
            clip.src = src;
          }
        }
      }
    }

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const remotionRoot = path.resolve(__dirname, '../../../../remotion-template');
    const entryPoint = path.join(remotionRoot, 'src', 'index.ts');

    try {
      await fs.access(entryPoint);
    } catch {
      onLog?.(`[RemotionRender] ERROR: Remotion template not found at ${remotionRoot}`);
      return { success: false, error: 'Remotion template not found. Ensure remotion-template exists.' };
    }

    onProgress?.(10, 'Bundling Remotion');
    onLog?.('[RemotionRender] Bundling...');

    let serveUrl: string;
    try {
      serveUrl = await bundle({
        entryPoint,
        rootDir: remotionRoot,
        webpackOverride: (config) => config,
      });
      onLog?.(`[RemotionRender] Bundle ready: ${serveUrl}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`[RemotionRender] ERROR: Bundle failed: ${msg}`);
      if (staticServer) staticServer.close();
      return { success: false, error: `Remotion bundle failed: ${msg}` };
    }

    const inputProps = { scene: { ...sceneForRender, width, height, fps } };

    let composition;
    try {
      composition = await selectComposition({
        serveUrl,
        id: 'Scene',
        inputProps,
      });
      onLog?.(`[RemotionRender] Composition: ${composition.width}x${composition.height}, ${composition.durationInFrames} frames`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`[RemotionRender] ERROR: selectComposition failed: ${msg}`);
      if (staticServer) staticServer.close();
      return { success: false, error: `Failed to select composition: ${msg}` };
    }

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, 'output.mp4');

    onProgress?.(20, 'Rendering video');

    const baseOpts: Parameters<typeof renderMedia>[0] = {
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = 20 + Math.round(progress * 78);
        onProgress?.(pct, `Rendering ${pct}%`);
      },
      chromiumOptions: { headless: true },
      /** OffthreadVideo must download full video before extracting frames; increase timeout for large/slow remote URLs */
      timeoutInMilliseconds: 120_000,
    };

    const renderOpts =
      speedMode === 'fast'
        ? {
            ...baseOpts,
            concurrency: '100%' as const,
            x264Preset: 'veryfast' as const,
            hardwareAcceleration: 'if-possible' as const,
            videoBitrate: '8M' as const,
          }
        : speedMode === 'draft'
          ? {
              ...baseOpts,
              concurrency: '100%' as const,
              x264Preset: 'ultrafast' as const,
              hardwareAcceleration: 'if-possible' as const,
              videoBitrate: '4M' as const,
              scale: 0.5,
            }
          : baseOpts;

    if (speedMode === 'fast') onLog?.('[RemotionRender] Speed mode: Fast (HW accel, veryfast preset)');
    else if (speedMode === 'draft') onLog?.('[RemotionRender] Speed mode: Draft (half res, ultrafast)');

    try {
      await renderMedia(renderOpts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`[RemotionRender] ERROR: Render failed: ${msg}`);
      if (staticServer) staticServer.close();
      return { success: false, error: `Render failed: ${msg}` };
    } finally {
      if (staticServer) {
        staticServer.close();
        onLog?.('[RemotionRender] Asset server closed');
      }
    }

    try {
      await fs.access(outputPath);
    } catch {
      onLog?.('[RemotionRender] ERROR: Output file was not created');
      return { success: false, error: 'Render completed but output file was not created.' };
    }

    const stat = await fs.stat(outputPath);
    onLog?.(`[RemotionRender] Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);

    await fs.writeFile(
      path.join(outDir, 'scene.json'),
      JSON.stringify({ ...scene, width, height, fps }, null, 2),
      'utf8'
    );

    onProgress?.(100, 'Done');
    onLog?.('[RemotionRender] === Module complete ===');

    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
