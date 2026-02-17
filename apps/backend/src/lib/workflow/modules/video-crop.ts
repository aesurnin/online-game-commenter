import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

export const videoCropMeta = {
  type: 'video.crop',
  label: 'Crop Video',
  description: 'Crop video to specific dimensions',
  quickParams: ['width', 'height'],
  inputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  outputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  paramsSchema: [
    { key: 'x', label: 'X (Left)', type: 'number' as const, default: 0, min: 0 },
    { key: 'y', label: 'Y (Top)', type: 'number' as const, default: 0, min: 0 },
    { key: 'width', label: 'Width', type: 'number' as const, default: 1920, min: 0 },
    { key: 'height', label: 'Height', type: 'number' as const, default: 1080, min: 0 },
  ],
};

export class VideoCropModule implements WorkflowModule {
  readonly meta = videoCropMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const x = Math.max(0, Number(params.x) ?? 0);
    const y = Math.max(0, Number(params.y) ?? 0);
    const w = Math.max(0, Number(params.width) ?? 0);
    const h = Math.max(0, Number(params.height) ?? 0);
    
    const { onProgress, onLog } = context;
    const inputPath = context.currentVideoPath;

    try {
      await fs.access(inputPath);
    } catch {
      return { success: false, error: `Input video not found: ${inputPath}` };
    }

    if (w === 0 || h === 0) {
       return { success: false, error: `Invalid crop dimensions: ${w}x${h}` };
    }

    onLog?.(`Starting crop: x=${x}, y=${y}, w=${w}, h=${h}`);
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
