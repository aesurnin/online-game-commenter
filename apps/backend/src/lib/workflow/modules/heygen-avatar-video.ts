import fs from 'fs/promises';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { contentLibraryItems } from '../../../db/schema/index.js';
import { getObjectFromR2 } from '../../r2.js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

const HEYGEN_UPLOAD_TALKING_PHOTO = 'https://upload.heygen.com/v1/talking_photo';
const HEYGEN_UPLOAD_ASSET = 'https://upload.heygen.com/v1/asset';
const HEYGEN_VIDEO_GENERATE = 'https://api.heygen.com/v2/video/generate';
const HEYGEN_VIDEO_STATUS = 'https://api.heygen.com/v1/video_status.get';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 600_000; // 10 min

/** HeyGen pricing per minute of output video (USD) */
const COST_PER_MIN_AVATAR_III = 0.25;
const COST_PER_MIN_AVATAR_IV = 6;

export const heygenAvatarVideoMeta = {
  type: 'video.heygen.avatar',
  label: 'HeyGen Avatar Video',
  description: 'Generate talking avatar video from an image (avatar) and audio using HeyGen API',
  category: 'Video',
  quickParams: ['imageId', 'engineVersion', 'apiKeyEnvVar'],
  inputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  outputSlots: [
    { key: 'video', label: 'Video', kind: 'video' as const },
  ],
  paramsSchema: [
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'HEYGEN_API_KEY' },
    { key: 'imageId', label: 'Avatar image', type: 'string' as const, default: '' },
    { key: 'engineVersion', label: 'Engine version', type: 'string' as const, default: 'avatar_iv',
      options: [
        { value: 'avatar_iv', label: 'Avatar IV (latest, more expressive)' },
        { value: 'avatar_iii', label: 'Avatar III (legacy)' },
      ] },
    { key: 'backgroundColor', label: 'Background color (hex)', type: 'string' as const, default: '#FAFAFA' },
  ],
};

async function uploadTalkingPhoto(apiKey: string, imageBuffer: Buffer, mimeType: string): Promise<string> {
  const contentType = mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
  const res = await fetch(HEYGEN_UPLOAD_TALKING_PHOTO, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': contentType,
    },
    body: new Uint8Array(imageBuffer),
  });
  const json = (await res.json()) as { code?: number; data?: { talking_photo_id?: string }; message?: string };
  if (!res.ok || json.code !== 100) {
    throw new Error(json.message ?? `HeyGen talking photo upload failed: ${res.status}`);
  }
  const id = json.data?.talking_photo_id;
  if (!id) throw new Error('HeyGen did not return talking_photo_id');
  return id;
}

const AUDIO_MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

async function uploadAudioAsset(apiKey: string, audioBuffer: Buffer, audioPath: string): Promise<string> {
  const ext = path.extname(audioPath).toLowerCase();
  const contentType = AUDIO_MIME[ext] ?? 'audio/mpeg';
  const res = await fetch(HEYGEN_UPLOAD_ASSET, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': contentType,
    },
    body: new Uint8Array(audioBuffer),
  });
  const json = (await res.json()) as { code?: number; data?: { url?: string; id?: string }; message?: string };
  if (!res.ok || json.code !== 100) {
    throw new Error(json.message ?? `HeyGen audio upload failed: ${res.status}`);
  }
  const url = json.data?.url;
  if (!url) throw new Error('HeyGen did not return audio URL');
  return url;
}

async function createVideo(
  apiKey: string,
  talkingPhotoId: string,
  audioUrl: string,
  backgroundColor: string,
  useAvatarIv: boolean
): Promise<string> {
  const body = {
    video_inputs: [
      {
        character: {
          type: 'talking_photo',
          talking_photo_id: talkingPhotoId,
          use_avatar_iv_model: useAvatarIv,
        },
        voice: {
          type: 'audio',
          audio_url: audioUrl,
        },
        background: {
          type: 'color',
          value: backgroundColor.startsWith('#') ? backgroundColor : `#${backgroundColor}`,
        },
      },
    ],
  };
  const res = await fetch(HEYGEN_VIDEO_GENERATE, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { error?: string; data?: { video_id?: string } };
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `HeyGen video create failed: ${res.status}`);
  }
  const videoId = json.data?.video_id;
  if (!videoId) throw new Error('HeyGen did not return video_id');
  return videoId;
}

interface PollResult {
  videoUrl: string;
  durationSeconds: number;
  statusPollCount: number;
}

async function pollVideoStatus(
  apiKey: string,
  videoId: string,
  onProgress?: (percent: number, message: string) => void,
  signal?: AbortSignal
): Promise<PollResult> {
  const start = Date.now();
  let statusPollCount = 0;
  while (true) {
    if (signal?.aborted) throw new Error('Aborted by user');
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error('HeyGen video generation timed out');

    statusPollCount++;
    const res = await fetch(`${HEYGEN_VIDEO_STATUS}?video_id=${encodeURIComponent(videoId)}`, {
      headers: { 'x-api-key': apiKey },
    });
    const json = (await res.json()) as {
      code?: number;
      data?: { status?: string; video_url?: string; duration?: number; error?: { message?: string } };
    };
    if (!res.ok || json.code !== 100) {
      throw new Error(`HeyGen status check failed: ${res.status}`);
    }
    const status = json.data?.status;
    const statusMsg = status ?? 'unknown';

    if (status === 'completed') {
      const url = json.data?.video_url;
      if (!url) throw new Error('HeyGen completed but no video_url');
      const durationSeconds = json.data?.duration ?? 0;
      return { videoUrl: url, durationSeconds, statusPollCount };
    }
    if (status === 'failed') {
      const err = json.data?.error;
      throw new Error(err?.message ?? 'HeyGen video generation failed');
    }

    const pct = status === 'processing' ? 70 : status === 'waiting' ? 50 : 30;
    onProgress?.(pct, `HeyGen: ${statusMsg}`);

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function downloadVideo(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download video: ${res.status}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

export class HeyGenAvatarVideoModule implements WorkflowModule {
  readonly meta = heygenAvatarVideoMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;

    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'HEYGEN_API_KEY');
    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey?.trim()) {
      onLog?.(`[HeyGen Avatar] ERROR: API key not set. Set env var: ${apiKeyEnvVar}`);
      return { success: false, error: `API key not set. Set environment variable: ${apiKeyEnvVar}` };
    }

    const imageId = String(params.imageId ?? '').trim();
    if (!imageId) {
      onLog?.('[HeyGen Avatar] ERROR: No avatar image selected. Choose an image from the library.');
      return { success: false, error: 'No avatar image selected. Choose an image from the library.' };
    }

    const inputPaths = context.inputPaths ?? {};
    const audioPath = inputPaths['audio'] ?? context.currentAudioPath;
    if (!audioPath) {
      onLog?.('[HeyGen Avatar] ERROR: No audio input. Connect an audio source.');
      return { success: false, error: 'No audio input. Connect an audio source.' };
    }

    try {
      await fs.access(audioPath);
    } catch {
      onLog?.(`[HeyGen Avatar] ERROR: Audio file not found: ${audioPath}`);
      return { success: false, error: `Audio file not found: ${audioPath}` };
    }

    const backgroundColor = String(params.backgroundColor ?? '#FAFAFA').trim();
    const engineVersion = String(params.engineVersion ?? 'avatar_iv');
    const useAvatarIv = engineVersion === 'avatar_iv';

    onLog?.('[HeyGen Avatar] === Module start ===');
    onLog?.(`[HeyGen Avatar] Engine: ${engineVersion === 'avatar_iv' ? 'Avatar IV' : 'Avatar III'}, Image: ${imageId}, Audio: ${audioPath}`);

    onProgress?.(0, 'Loading avatar image');

    const [imageItem] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, imageId), eq(contentLibraryItems.type, 'image'))
    );
    if (!imageItem) {
      onLog?.(`[HeyGen Avatar] ERROR: Image not found in library: ${imageId}`);
      return { success: false, error: `Image not found in library: ${imageId}` };
    }

    let imageBuffer: Buffer;
    try {
      imageBuffer = await getObjectFromR2(imageItem.r2Key);
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: Failed to download image: ${err}`);
      return { success: false, error: 'Failed to download avatar image from storage' };
    }

    const ext = path.extname(imageItem.r2Key).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

    onProgress?.(10, 'Uploading avatar to HeyGen');
    onLog?.('[HeyGen Avatar] Uploading talking photo...');

    let talkingPhotoId: string;
    try {
      talkingPhotoId = await uploadTalkingPhoto(apiKey, imageBuffer, mimeType);
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: ${(err as Error).message}`);
      return { success: false, error: `HeyGen talking photo upload failed: ${(err as Error).message}` };
    }
    onLog?.(`[HeyGen Avatar] Talking photo ID: ${talkingPhotoId}`);

    onProgress?.(20, 'Uploading audio to HeyGen');
    onLog?.('[HeyGen Avatar] Uploading audio...');

    const audioBuffer = await fs.readFile(audioPath);
    let audioUrl: string;
    try {
      audioUrl = await uploadAudioAsset(apiKey, audioBuffer, audioPath);
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: ${(err as Error).message}`);
      return { success: false, error: `HeyGen audio upload failed: ${(err as Error).message}` };
    }
    onLog?.(`[HeyGen Avatar] Audio URL: ${audioUrl.slice(0, 60)}...`);

    onProgress?.(25, 'Creating video job');
    onLog?.('[HeyGen Avatar] Creating video (1 API call — this is the billed request)...');

    let videoId: string;
    try {
      videoId = await createVideo(apiKey, talkingPhotoId, audioUrl, backgroundColor, useAvatarIv);
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: ${(err as Error).message}`);
      return { success: false, error: `HeyGen video create failed: ${(err as Error).message}` };
    }
    onLog?.(`[HeyGen Avatar] Video ID: ${videoId}`);

    onProgress?.(30, 'Waiting for video generation');

    let pollResult: PollResult;
    try {
      pollResult = await pollVideoStatus(
        apiKey,
        videoId,
        (pct, msg) => {
          onProgress?.(30 + (pct / 100) * 50, msg);
          onLog?.(`[HeyGen Avatar] ${msg}`);
        },
        context.signal
      );
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: ${(err as Error).message}`);
      return { success: false, error: `HeyGen video generation failed: ${(err as Error).message}` };
    }

    onProgress?.(85, 'Downloading video');
    onLog?.(`[HeyGen Avatar] API summary: 1 upload photo, 1 upload audio, 1 create video, ${pollResult.statusPollCount} status polls (status polls are free)`);

    let videoBuffer: Buffer;
    try {
      videoBuffer = await downloadVideo(pollResult.videoUrl);
    } catch (err) {
      onLog?.(`[HeyGen Avatar] ERROR: ${(err as Error).message}`);
      return { success: false, error: `Failed to download video: ${(err as Error).message}` };
    }

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, 'output.mp4');
    await fs.writeFile(outputPath, videoBuffer);

    const stat = await fs.stat(outputPath);
    const durationMin = pollResult.durationSeconds / 60;
    const costPerMin = useAvatarIv ? COST_PER_MIN_AVATAR_IV : COST_PER_MIN_AVATAR_III;
    const costUsd = Math.round(durationMin * costPerMin * 10000) / 10000;

    onLog?.(`[HeyGen Avatar] Output: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB, ${pollResult.durationSeconds.toFixed(1)}s)`);
    onLog?.(`[HeyGen Avatar] Cost: $${costUsd.toFixed(4)} (${durationMin.toFixed(2)} min × $${costPerMin}/min)`);

    const metadata = {
      provider: 'heygen',
      videoId,
      engineVersion,
      durationSeconds: pollResult.durationSeconds,
      costUsd,
    };
    await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

    onProgress?.(100, 'Done');
    onLog?.('[HeyGen Avatar] === Module complete ===');

    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
