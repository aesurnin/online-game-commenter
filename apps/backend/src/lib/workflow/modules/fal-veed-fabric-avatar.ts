import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { eq, and } from 'drizzle-orm';
import { fal } from '@fal-ai/client';
import { db } from '../../../db/index.js';
import { contentLibraryItems } from '../../../db/schema/index.js';
import { getPresignedUrl } from '../../r2.js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

/** fal.ai VEED Fabric 1.0 pricing per second of output video (USD) */
const COST_PER_SEC_480P = 0.08;
const COST_PER_SEC_720P = 0.15;

export const falVeedFabricAvatarMeta = {
  type: 'video.fal.veed-fabric',
  label: 'fal.ai VEED Fabric Avatar',
  description: 'Generate talking avatar video from an image and audio using fal.ai VEED Fabric 1.0',
  category: 'Video',
  quickParams: ['imageId', 'resolution', 'apiKeyEnvVar'],
  inputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  outputSlots: [
    { key: 'video', label: 'Video', kind: 'video' as const },
  ],
  paramsSchema: [
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'FAL_KEY' },
    { key: 'imageId', label: 'Avatar image', type: 'string' as const, default: '' },
    { key: 'resolution', label: 'Resolution', type: 'string' as const, default: '720p',
      options: [
        { value: '720p', label: '720p ($0.15/sec)' },
        { value: '480p', label: '480p ($0.08/sec)' },
      ] },
  ],
};

async function uploadAudioToFal(apiKey: string, filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.aac': 'audio/aac',
  };
  const contentType = mimeTypes[ext] ?? 'audio/mpeg';
  const blob = new Blob([buffer], { type: contentType });

  fal.config({ credentials: apiKey });
  const url = await fal.storage.upload(blob);
  return url;
}

async function runFabricGeneration(
  apiKey: string,
  imageUrl: string,
  audioUrl: string,
  resolution: string,
  onProgress?: (percent: number, message: string) => void
): Promise<{ videoUrl: string }> {
  fal.config({ credentials: apiKey });
  // Use subscribe (queue) instead of run — avoids Node.js fetch timeout on long 3–4 min generations
  const result = await fal.subscribe('veed/fabric-1.0', {
    input: {
      image_url: imageUrl,
      audio_url: audioUrl,
      resolution: resolution as '720p' | '480p',
    },
    logs: true,
    onQueueUpdate: (update) => {
      const status = (update as { status?: string; logs?: Array<{ message?: string }> }).status;
      const logs = (update as { status?: string; logs?: Array<{ message?: string }> }).logs;
      const msg = status === 'IN_QUEUE' ? 'In queue' : status === 'IN_PROGRESS' ? (logs?.[logs.length - 1]?.message ?? 'Processing') : String(status ?? '');
      onProgress?.(status === 'IN_QUEUE' ? 10 : 50, `fal.ai: ${msg}`);
    },
  });

  const output = (result as { data?: { video?: { url?: string } } }).data;
  const videoUrl = output?.video?.url;
  if (!videoUrl) {
    throw new Error(`fal.ai did not return video URL. Response keys: ${JSON.stringify(Object.keys(result ?? {}))}`);
  }
  return { videoUrl };
}

async function downloadVideo(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

export class FalVeedFabricAvatarModule implements WorkflowModule {
  readonly meta = falVeedFabricAvatarMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;

    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'FAL_KEY');
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey?.trim()) {
      onLog?.(`[fal.ai Fabric] ERROR: API key not set. Set env var: ${apiKeyEnvVar}`);
      return { success: false, error: `API key not set. Set environment variable: ${apiKeyEnvVar}` };
    }

    const imageId = String(params.imageId ?? '').trim();
    if (!imageId) {
      onLog?.('[fal.ai Fabric] ERROR: No avatar image selected. Choose an image from the library.');
      return { success: false, error: 'No avatar image selected. Choose an image from the library.' };
    }

    const inputPaths = context.inputPaths ?? {};
    const audioPath = inputPaths['audio'] ?? context.currentAudioPath;
    if (!audioPath) {
      onLog?.('[fal.ai Fabric] ERROR: No audio input. Connect an audio source.');
      return { success: false, error: 'No audio input. Connect an audio source.' };
    }

    try {
      await fs.access(audioPath);
    } catch {
      onLog?.(`[fal.ai Fabric] ERROR: Audio file not found: ${audioPath}`);
      return { success: false, error: `Audio file not found: ${audioPath}` };
    }

    const resolution = String(params.resolution ?? '720p');

    onLog?.('[fal.ai Fabric] === Module start ===');
    onLog?.(`[fal.ai Fabric] Resolution: ${resolution}, Image: ${imageId}, Audio: ${audioPath}`);

    onProgress?.(0, 'Preparing avatar image');

    const [imageItem] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, imageId), eq(contentLibraryItems.type, 'image'))
    );
    if (!imageItem) {
      onLog?.(`[fal.ai Fabric] ERROR: Image not found in library: ${imageId}`);
      return { success: false, error: `Image not found in library: ${imageId}` };
    }

    let imageUrl: string;
    try {
      imageUrl = await getPresignedUrl(imageItem.r2Key, 3600);
    } catch (err) {
      onLog?.(`[fal.ai Fabric] ERROR: Failed to get presigned URL: ${err}`);
      return { success: false, error: 'Failed to access avatar image from storage' };
    }

    onProgress?.(10, 'Uploading audio to fal.ai');
    onLog?.('[fal.ai Fabric] Uploading audio...');

    let audioUrl: string;
    try {
      audioUrl = await uploadAudioToFal(apiKey, audioPath);
    } catch (err) {
      onLog?.(`[fal.ai Fabric] ERROR: ${(err as Error).message}`);
      return { success: false, error: `fal.ai audio upload failed: ${(err as Error).message}` };
    }
    onLog?.(`[fal.ai Fabric] Audio URL: ${audioUrl.slice(0, 60)}...`);

    onProgress?.(20, 'Generating video');
    onLog?.('[fal.ai Fabric] Calling veed/fabric-1.0 (queue mode)...');

    let result: { videoUrl: string };
    try {
      result = await runFabricGeneration(apiKey, imageUrl, audioUrl, resolution, (pct, msg) => {
        onProgress?.(20 + (pct / 100) * 60, msg);
        onLog?.(`[fal.ai Fabric] ${msg}`);
      });
    } catch (err) {
      onLog?.(`[fal.ai Fabric] ERROR: ${(err as Error).message}`);
      return { success: false, error: `fal.ai generation failed: ${(err as Error).message}` };
    }

    onProgress?.(85, 'Downloading video');
    onLog?.('[fal.ai Fabric] Downloading result...');

    let videoBuffer: Buffer;
    try {
      videoBuffer = await downloadVideo(result.videoUrl);
    } catch (err) {
      onLog?.(`[fal.ai Fabric] ERROR: ${(err as Error).message}`);
      return { success: false, error: `Failed to download video: ${(err as Error).message}` };
    }

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, 'output.mp4');
    await fs.writeFile(outputPath, videoBuffer);

    let durationSeconds = 0;
    try {
      const ffprobe = await new Promise<string>((resolve, reject) => {
        const proc = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          outputPath
        ]);
        let out = '';
        proc.stdout?.on('data', (d) => out += d);
        proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject());
        proc.on('error', reject);
      });
      durationSeconds = parseFloat(ffprobe) || 0;
    } catch {
      onLog?.('[fal.ai Fabric] WARN: Could not determine video duration with ffprobe');
    }

    const costPerSec = resolution === '720p' ? COST_PER_SEC_720P : COST_PER_SEC_480P;
    const costUsd = Math.round(durationSeconds * costPerSec * 10000) / 10000;

    const stat = await fs.stat(outputPath);
    onLog?.(`[fal.ai Fabric] Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB, ${durationSeconds.toFixed(1)}s)`);
    if (costUsd > 0) {
      onLog?.(`[fal.ai Fabric] Cost: $${costUsd.toFixed(4)} (${durationSeconds.toFixed(1)}s × $${costPerSec}/s)`);
    }

    const metadata = {
      provider: 'fal.ai',
      model: 'veed/fabric-1.0',
      resolution,
      durationSeconds,
      costUsd,
    };
    await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    onProgress?.(100, 'Done');
    onLog?.('[fal.ai Fabric] === Module complete ===');

    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
