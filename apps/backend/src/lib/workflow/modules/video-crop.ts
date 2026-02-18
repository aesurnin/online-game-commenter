import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

async function getVideoDimensions(inputPath: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0',
      '-i', inputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    if (signal) {
      if (signal.aborted) {
        proc.kill();
        return reject(new Error('Aborted'));
      }
      signal.addEventListener('abort', () => {
        proc.kill();
        reject(new Error('Aborted'));
      }, { once: true });
    }

    let out = '';
    proc.stdout?.on('data', (c) => { out += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const [width, height] = out.trim().split(',').map(Number);
      if (!width || !height) return reject(new Error('Could not parse dimensions'));
      resolve({ width, height });
    });
  });
}

export const videoCropMeta = {
  type: 'video.crop',
  label: 'Crop Video',
  description: 'Crop video by percentage (4 edges: left, top, right, bottom)',
  category: 'Video',
  quickParams: ['left', 'top', 'right', 'bottom'],
  inputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  outputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  paramsSchema: [
    { key: 'left', label: 'Left margin (%)', type: 'number' as const, default: 0, min: 0, max: 100 },
    { key: 'top', label: 'Top margin (%)', type: 'number' as const, default: 0, min: 0, max: 100 },
    { key: 'right', label: 'Right margin (%)', type: 'number' as const, default: 0, min: 0, max: 100 },
    { key: 'bottom', label: 'Bottom margin (%)', type: 'number' as const, default: 0, min: 0, max: 100 },
  ],
};

/** Params: left, top, right, bottom = margin % from each edge (0–100). */
function paramsToLtwh(params: Record<string, unknown>): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.min(100, Number(params.left) ?? 0));
  const top = Math.max(0, Math.min(100, Number(params.top) ?? 0));
  const right = Math.max(0, Math.min(100, Number(params.right) ?? 0));
  const bottom = Math.max(0, Math.min(100, Number(params.bottom) ?? 0));
  const width = Math.max(0, 100 - left - right);
  const height = Math.max(0, 100 - top - bottom);
  return { left, top, width, height };
}

export class VideoCropModule implements WorkflowModule {
  readonly meta = videoCropMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { left: leftPct, top: topPct, width: widthPct, height: heightPct } = paramsToLtwh(params);

    const { onProgress, onLog } = context;
    const inputPath = context.currentVideoPath;

    try {
      await fs.access(inputPath);
    } catch {
      return { success: false, error: `Input video not found: ${inputPath}` };
    }

    if (widthPct < 0.1 || heightPct < 0.1) {
      return { success: false, error: `Invalid crop: width=${widthPct}% height=${heightPct}%` };
    }

    let width: number;
    let height: number;
    try {
      const dims = await getVideoDimensions(inputPath, context.signal);
      width = dims.width;
      height = dims.height;
    } catch (e) {
      return { success: false, error: `Could not get video dimensions: ${e}` };
    }

    const x = Math.round((leftPct / 100) * width) & ~1;
    const y = Math.round((topPct / 100) * height) & ~1;
    const w = Math.round((widthPct / 100) * width) & ~1;
    const h = Math.round((heightPct / 100) * height) & ~1;

    if (w <= 0 || h <= 0) {
      return { success: false, error: `Invalid crop dimensions: ${w}x${h}` };
    }

    onLog?.(`Crop: ${leftPct}%,${topPct}% ${widthPct}%x${heightPct}% -> ${x},${y} ${w}x${h}px`);
    onProgress?.(0, 'Preparing');

    const ext = path.extname(inputPath) || '.mp4';
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, `crop_output${ext}`);

    // ffmpeg -i input.mp4 -vf "crop=w:h:x:y" output.mp4
    const args: string[] = [
      '-y',
      '-i', inputPath,
      '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-c:v', 'libx264',
      '-c:a', 'copy', // Copy audio without re-encoding if possible, or use 'aac'
      '-preset', 'fast',
      '-crf', '23', 
      outputPath,
    ];

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      if (context.signal) {
        if (context.signal.aborted) {
          proc.kill();
          return resolve(false);
        }
        context.signal.addEventListener('abort', () => {
          proc.kill();
          resolve(false);
        }, { once: true });
      }

      proc.on('error', (err) => {
        onLog?.(`Spawn error: ${err}`);
        resolve(false);
      });
      proc.on('close', (code) => resolve(code === 0));

      // Capture stderr for progress parsing (generic approach)
      proc.stderr?.on('data', (chunk: Buffer) => {
         // We can implement progress parsing here if needed, similar to compressor
         const text = chunk.toString();
         if (text.toLowerCase().includes('error')) {
            onLog?.(`[FFmpeg Error] ${text}`);
         }
      });

      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(false);
      }, 600_000); // 10 min timeout
    });

    if (!ok) {
      return { success: false, error: 'FFmpeg crop failed' };
    }

    onProgress?.(100, 'Done');
    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
