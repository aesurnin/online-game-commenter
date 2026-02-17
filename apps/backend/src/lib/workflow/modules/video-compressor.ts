import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

const FFMPEG_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

function parseDuration(s: string): number {
  const m = s.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

function parseTime(s: string): number {
  const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

export const videoCompressorMeta = {
  type: 'video.compress',
  label: 'Compress Video',
  description: 'Compress video quality and reduce file size using FFmpeg',
  category: 'Video',
  quickParams: ['crf'],
  inputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  outputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  paramsSchema: [
    { key: 'crf', label: 'Quality (CRF)', type: 'number' as const, default: 23, min: 0, max: 51 },
    { key: 'preset', label: 'Encoding preset', type: 'string' as const, default: 'fast', options: FFMPEG_PRESETS.map((p) => ({ value: p, label: p })) },
    { key: 'width', label: 'Width (0 = keep)', type: 'number' as const, default: 0, min: 0 },
  ],
};

export class VideoCompressorModule implements WorkflowModule {
  readonly meta = videoCompressorMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const crf = Math.max(0, Math.min(51, Number(params.crf) ?? 23));
    const preset = String(params.preset ?? 'fast');
    const width = Math.max(0, Number(params.width) ?? 0);
    const { onProgress, onLog } = context;

    const inputPath = context.currentVideoPath;
    try {
      await fs.access(inputPath);
    } catch {
      return { success: false, error: `Input video not found: ${inputPath}` };
    }

    onLog?.('Input video found, starting compression...');
    onProgress?.(0, 'Preparing');

    const ext = path.extname(inputPath) || '.mp4';
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, `output${ext}`);

    const args: string[] = [
      '-y',
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', FFMPEG_PRESETS.includes(preset as typeof FFMPEG_PRESETS[number]) ? preset : 'fast',
      '-crf', String(crf),
      '-c:a', 'aac',
      '-b:a', '128k',
    ];
    if (width > 0) {
      args.push('-vf', `scale=${width}:-2`);
    }
    args.push(outputPath);

    let durationSec = 0;

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (durationSec === 0) {
            const d = parseDuration(line);
            if (d > 0) {
              durationSec = d;
              onLog?.(`Source duration: ${durationSec.toFixed(1)}s`);
            }
          }
          const t = parseTime(line);
          if (t > 0 && durationSec > 0) {
            const pct = Math.min(99, Math.round((t / durationSec) * 100));
            onProgress?.(pct, `Encoding ${pct}%`);
          }
        }
      });

      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(false);
      }, 600_000);
    });

    if (!ok) {
      onLog?.('FFmpeg exited with error');
      return { success: false, error: 'FFmpeg compression failed' };
    }

    onProgress?.(100, 'Done');
    onLog?.('Compression completed successfully');

    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
