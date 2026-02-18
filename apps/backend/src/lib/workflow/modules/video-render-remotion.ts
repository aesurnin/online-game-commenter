import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

/** Scene clip from JSON */
interface SceneClip {
  type: string;
  src: string;
  from: number;
  durationInFrames: number;
  layout?: 'fill' | 'contain' | 'cover';
}

/** Scene JSON schema */
interface SceneJson {
  width?: number;
  height?: number;
  fps?: number;
  durationInFrames?: number;
  clips?: SceneClip[];
  backgroundColor?: string;
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

export class VideoRenderRemotionModule implements WorkflowModule {
  readonly meta = videoRenderRemotionMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};

    onLog?.('[RemotionRender] === Module start ===');

    const sceneSource = String(params.sceneSource ?? 'variable');
    let scene: SceneJson;

    if (sceneSource === 'inline') {
      const inlineJson = String(params.sceneJsonInline ?? '').trim();
      if (!inlineJson) {
        onLog?.('[RemotionRender] ERROR: Inline scene JSON is empty');
        return { success: false, error: 'Inline scene JSON is empty. Enter scene JSON or switch to Variable mode.' };
      }
      try {
        scene = JSON.parse(inlineJson) as SceneJson;
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
        scene = JSON.parse(sceneRaw) as SceneJson;
      } catch (e) {
        onLog?.(`[RemotionRender] ERROR: Invalid JSON: ${e}`);
        return { success: false, error: 'Scene file must be valid JSON.' };
      }
    }

    const width = Math.max(320, Math.min(4096, Number(scene.width ?? 1920)));
    const height = Math.max(240, Math.min(2160, Number(scene.height ?? 1080)));
    const fps = Math.max(1, Math.min(60, Number(scene.fps ?? 30)));

    const cacheBase = getWorkflowCacheBase();
    const videoDir = path.join(cacheBase, context.projectId, context.videoId);

    let staticServer: http.Server | null = null;
    let baseUrl = '';

    if (scene.clips?.length) {
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

      for (const clip of scene.clips) {
        if (clip.type === 'video' && clip.src) {
          if (clip.src.startsWith('http://') || clip.src.startsWith('https://')) {
            continue;
          }
          const rel = toRelativeUrl(clip.src, videoDir);
          if (rel) {
            clip.src = baseUrl + rel;
          } else {
            onLog?.(`[RemotionRender] WARNING: Clip src not in cache dir, may fail: ${clip.src}`);
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

    const inputProps = { scene: { ...scene, width, height, fps } };

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

    try {
      await renderMedia({
        composition,
        serveUrl,
        codec: 'h264',
        outputLocation: outputPath,
        inputProps,
        onProgress: ({ progress }) => {
          const pct = 20 + Math.round(progress * 78);
          onProgress?.(pct, `Rendering ${pct}%`);
        },
        chromiumOptions: {
          headless: true,
        },
      });
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
