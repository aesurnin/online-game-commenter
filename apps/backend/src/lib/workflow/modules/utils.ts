import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
// Prompt placeholders
// ---------------------------------------------------------------------------

/** Placeholder format: {{variableName}}. Resolve with variables map; for .txt/.md paths read file content. */
export async function resolvePromptPlaceholders(
  template: string,
  variables: Record<string, string>,
): Promise<string> {
  const re = /\{\{([A-Za-z0-9_]+)\}\}/g;
  const matches = [...template.matchAll(re)];
  if (matches.length === 0) return template;

  const resolved = await Promise.all(
    matches.map(async (m) => {
      const name = m[1];
      const value = variables[name];
      if (value === undefined || value === '') return m[0];
      const ext = path.extname(value).toLowerCase();
      if (ext === '.txt' || ext === '.md') {
        try {
          const content = await fs.readFile(value, 'utf8');
          return content.trim();
        } catch {
          return `[file not found: ${name}]`;
        }
      }
      return value;
    }),
  );

  let result = '';
  let lastEnd = 0;
  for (let i = 0; i < matches.length; i++) {
    result += template.slice(lastEnd, matches[i].index);
    result += resolved[i];
    lastEnd = matches[i].index + matches[i][0].length;
  }
  result += template.slice(lastEnd);
  return result;
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------

/** Extract up to N frames from video at even intervals, return base64 JPEG strings. */
export async function extractFrames(
  videoPath: string,
  count: number,
  durationSec: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const outDir = path.dirname(videoPath);
  const prefix = path.join(outDir, `frame_${Date.now()}_`);
  const pattern = `${prefix}%03d.jpg`;
  const interval = durationSec > 0 ? durationSec / Math.max(1, count) : 1;

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-y',
        '-i', videoPath,
        '-vf', `fps=1/${interval},scale=iw:min(720\\,ih):force_original_aspect_ratio=decrease`,
        '-vframes', String(count),
        '-f', 'image2',
        pattern,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (signal) {
      if (signal.aborted) { proc.kill(); return reject(new Error('Aborted')); }
      signal.addEventListener('abort', () => { proc.kill(); reject(new Error('Aborted')); }, { once: true });
    }

    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });

  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    const num = String(i + 1).padStart(3, '0');
    const filePath = `${prefix}${num}.jpg`;
    try {
      const buf = await fs.readFile(filePath);
      frames.push(buf.toString('base64'));
      await fs.unlink(filePath);
    } catch {
      // skip missing frame
    }
  }
  return frames;
}

/** Get video duration in seconds using ffprobe. */
export async function getVideoDuration(videoPath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (signal) {
      if (signal.aborted) { proc.kill(); return reject(new Error('Aborted')); }
      signal.addEventListener('abort', () => { proc.kill(); reject(new Error('Aborted')); }, { once: true });
    }

    let out = '';
    proc.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
      const sec = parseFloat(out.trim());
      resolve(Number.isFinite(sec) ? sec : 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

/** Read image file to base64 data URL, or extract one frame from video. */
export async function readImageOrVideoFrame(filePath: string, signal?: AbortSignal): Promise<{ url: string }> {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXT.has(ext)) {
    const buf = await fs.readFile(filePath);
    const mime = IMAGE_MIME[ext] ?? 'image/jpeg';
    return { url: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const oneFrame = await extractFrames(filePath, 1, 1, signal);
  if (oneFrame.length === 0) throw new Error(`Could not extract frame from ${filePath}`);
  return { url: `data:image/jpeg;base64,${oneFrame[0]}` };
}

// ---------------------------------------------------------------------------
// OpenRouter API
// ---------------------------------------------------------------------------

export interface CallOpenRouterOpts {
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLog?: (msg: string) => void;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export async function callOpenRouter(
  opts: CallOpenRouterOpts,
): Promise<{ text: string; usage?: TokenUsage } | { error: string }> {
  const { apiKey, model, messages, maxTokens, temperature, signal, onLog } = opts;
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const requestBody = { model, messages, max_tokens: maxTokens, temperature };
  const bodyStr = JSON.stringify(requestBody);
  const bodySize = bodyStr.length;

  onLog?.(`[callOpenRouter] model=${model}, body=${(bodySize / 1024).toFixed(1)} KB`);
  if (bodySize > 4 * 1024 * 1024) {
    onLog?.('[callOpenRouter] WARNING: Body > 4 MB. Some APIs may truncate or reject large payloads.');
  }

  const fetchController = new AbortController();
  const timeoutId = setTimeout(() => fetchController.abort(), timeoutMs);
  signal?.addEventListener('abort', () => { clearTimeout(timeoutId); fetchController.abort(); }, { once: true });

  let res: Response;
  try {
    res = await fetch(OPENROUTER_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/SurninSynergy/online-game-commenter',
        'X-Title': 'Online Game Commenter',
      },
      signal: fetchController.signal,
      body: bodyStr,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error && e.name === 'AbortError'
      ? 'Request aborted (timeout or cancelled)'
      : String(e);
    onLog?.(`[callOpenRouter] FAILED: ${msg}`);
    return { error: `OpenRouter request failed: ${msg}` };
  }
  clearTimeout(timeoutId);

  onLog?.(`[callOpenRouter] status=${res.status}`);

  if (!res.ok) {
    const errText = await res.text();
    onLog?.(`[callOpenRouter] Error: ${res.status} ${errText.slice(0, 500)}`);
    return { error: `OpenRouter error ${res.status}: ${errText.slice(0, 500)}` };
  }

  const data = (await res.json()) as any;
  const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
  const usage = data?.usage
    ? {
        prompt_tokens: Number(data.usage.prompt_tokens) || 0,
        completion_tokens: Number(data.usage.completion_tokens) || 0,
        total_tokens: Number(data.usage.total_tokens) || 0,
      }
    : undefined;
  if (usage && usage.total_tokens > 0) {
    onLog?.(`[callOpenRouter] usage: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} total`);
  }
  onLog?.(`[callOpenRouter] response length=${text.length} chars`);

  return { text, usage };
}

// ---------------------------------------------------------------------------
// Media detection
// ---------------------------------------------------------------------------

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);

export function isVideoFile(filePath: string): boolean {
  return VIDEO_EXT.has(path.extname(filePath).toLowerCase());
}

export function isGeminiModel(model: string): boolean {
  return model.toLowerCase().includes('gemini');
}
