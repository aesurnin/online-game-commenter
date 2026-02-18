import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

/** Placeholder format: {{variableName}}. Resolve with context.variables; for .txt/.md paths read file content. */
async function resolvePromptPlaceholders(
  template: string,
  variables: Record<string, string>
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
    })
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

/** Extract up to N frames from video at even intervals, return base64 JPEG buffers. */
async function extractFrames(videoPath: string, count: number, durationSec: number, signal?: AbortSignal): Promise<string[]> {
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
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    
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
async function getVideoDuration(videoPath: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

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
      const sec = parseFloat(out.trim());
      resolve(Number.isFinite(sec) ? sec : 0);
    });
  });
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

/** Read image file to base64, or extract one frame from video. Returns data URL suffix (mime;base64,data). */
async function readImageOrVideoFrame(filePath: string, signal?: AbortSignal): Promise<{ url: string }> {
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

export const openrouterVisionMeta = {
  type: 'llm.openrouter.vision',
  label: 'OpenRouter Vision (Multimodal)',
  description: 'Send multiple videos, images, and a prompt to OpenRouter; returns text.',
  category: 'LLM',
  quickParams: ['model', 'prompt'],
  inputSlots: [
    { key: 'media_0', label: 'Media 1', kind: 'file' as const },
  ],
  // Custom flag for UI to show +/- buttons
  allowDynamicInputs: true,
  outputSlots: [{ key: 'text', label: 'Text', kind: 'text' as const }],
  paramsSchema: [
    { key: 'prompt', label: 'Prompt', type: 'prompt' as const, default: 'Describe what happens in this video.' },
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'OPENROUTER_API_KEY' },
    { key: 'model', label: 'Model', type: 'string' as const, default: 'openai/gpt-4o' },
    { key: 'maxTokens', label: 'Max tokens', type: 'number' as const, default: 1024, min: 1, max: 32000 },
    { key: 'temperature', label: 'Temperature', type: 'number' as const, default: 0.7, min: 0, max: 2 },
    { key: 'outputFormat', label: 'Output file format', type: 'string' as const, default: 'txt', options: [{ value: 'txt', label: 'Plain text (.txt)' }, { value: 'md', label: 'Markdown (.md)' }] },
  ],
};

export class OpenRouterVisionModule implements WorkflowModule {
  readonly meta = openrouterVisionMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};

    onLog?.('[OpenRouter Vision] === Module start ===');
    onLog?.(`[OpenRouter Vision] inputPaths keys: ${JSON.stringify(Object.keys(inputPaths))}`);
    for (const [k, v] of Object.entries(inputPaths)) {
      onLog?.(`[OpenRouter Vision] inputPaths["${k}"] = "${v}"`);
    }
    onLog?.(`[OpenRouter Vision] context.variables keys: ${JSON.stringify(Object.keys(context.variables ?? {}))}`);
    for (const [k, v] of Object.entries(context.variables ?? {})) {
      const preview = typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}...` : v;
      onLog?.(`[OpenRouter Vision] variables["${k}"] = "${preview}"`);
    }

    const promptTemplate = String(params.prompt ?? 'Describe the provided media.').trim();
    onLog?.('[OpenRouter Vision] Resolving prompt placeholders...');
    const prompt = await resolvePromptPlaceholders(promptTemplate, context.variables);
    
    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'OPENROUTER_API_KEY').trim();
    const model = String(params.model ?? 'openai/gpt-4o').trim();
    const maxTokens = Math.max(1, Math.min(32000, Number(params.maxTokens) ?? 1024));
    const temperature = Math.max(0, Math.min(2, Number(params.temperature) ?? 0.7));
    const outputFormat = String(params.outputFormat ?? 'txt').trim() === 'md' ? 'md' : 'txt';

    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      onLog?.(`Error: API key env var "${apiKeyEnvVar}" is not set.`);
      return { success: false, error: `Env variable "${apiKeyEnvVar}" is not set. Add it in Env Manager.` };
    }

    const isGemini = model.toLowerCase().includes('gemini');
    onLog?.(`Target model: ${model} (Gemini native support: ${isGemini})`);

    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
      | { type: 'video_url'; video_url: { url: string } }
    > = [
      { type: 'text', text: prompt },
    ];

    // Collect all media inputs (media_0, media_1, etc.)
    const mediaKeys = Object.keys(inputPaths).filter(k => k.startsWith('media_')).sort();
    onLog?.(`[OpenRouter Vision] Found ${mediaKeys.length} media input(s) to process: ${mediaKeys.join(', ')}`);

    for (const [idx, key] of mediaKeys.entries()) {
      const filePath = inputPaths[key];
      onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Processing "${key}" -> path: "${filePath}"`);

      if (!filePath) {
        onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] SKIP: filePath is empty or undefined`);
        continue;
      }

      let stat: { size: number; exists: boolean } = { size: 0, exists: false };
      try {
        const s = await fs.stat(filePath);
        stat = { size: s.size, exists: true };
        onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] File exists, size: ${(s.size / 1024).toFixed(1)} KB`);
      } catch (e) {
        onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] WARNING: File not found or not accessible: ${filePath}`);
        onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Error: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }

      const ext = path.extname(filePath).toLowerCase();
      const isVideo = ['.mp4', '.webm', '.mov', '.mkv'].includes(ext);
      onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Extension: "${ext}", isVideo: ${isVideo}, isGemini: ${isGemini}`);

      if (isVideo) {
        if (isGemini) {
          onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Sending video file directly (Gemini native support)...`);
          try {
            const buf = await fs.readFile(filePath);
            const b64Len = buf.toString('base64').length;
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Video read: ${(buf.length / 1024).toFixed(1)} KB raw, base64 length: ${(b64Len / 1024).toFixed(1)} KB`);
            content.push({
              type: 'video_url',
              video_url: { url: `data:video/mp4;base64,${buf.toString('base64')}` },
            });
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Video part added to content (type: video_url)`);
          } catch (e) {
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] FAILED to read video: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Non-Gemini model. Extracting frames for video...`);
          try {
            const duration = await getVideoDuration(filePath, context.signal);
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Video duration: ${duration.toFixed(1)}s. Sampling 1 fps.`);
            const frameCount = Math.min(Math.max(1, Math.ceil(duration)), 100);
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Extracting ${frameCount} frame(s)...`);
            const frames = await extractFrames(filePath, frameCount, duration, context.signal);
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Extracted ${frames.length} frame(s). Adding to content.`);
            for (const b64 of frames) {
              content.push({
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${b64}` },
              });
            }
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Added ${frames.length} image parts to content`);
          } catch (e) {
            onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Frame extraction FAILED: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Processing as image...`);
        try {
          const { url } = await readImageOrVideoFrame(filePath, context.signal);
          const urlLen = url.length;
          content.push({ type: 'image_url', image_url: { url } });
          onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] Image part added (data URL length: ${(urlLen / 1024).toFixed(1)} KB)`);
        } catch (e) {
          onLog?.(`[OpenRouter Vision] [Input ${idx + 1}] FAILED to read image: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const mediaPartCount = content.length - 1;
    const contentTypes = content.map((c) => c.type);
    onLog?.(`[OpenRouter Vision] Content summary: ${content.length} part(s) total. Types: ${contentTypes.join(', ')}`);

    if (content.length === 1) {
      onLog?.('[OpenRouter Vision] WARNING: No media parts added. Sending text-only prompt. LLM will NOT see any video/image.');
    } else {
      onLog?.(`[OpenRouter Vision] Payload prepared with ${mediaPartCount} media part(s).`);
    }

    onProgress?.(40, 'Calling OpenRouter');
    const requestBody = {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature,
    };
    const bodyStr = JSON.stringify(requestBody);
    const bodySize = bodyStr.length;
    onLog?.(`[OpenRouter Vision] Sending request to OpenRouter (model: ${model})...`);
    onLog?.(`[OpenRouter Vision] Request body size: ${(bodySize / 1024).toFixed(1)} KB (${(bodySize / 1024 / 1024).toFixed(2)} MB)`);
    if (bodySize > 4 * 1024 * 1024) {
      onLog?.(`[OpenRouter Vision] WARNING: Body > 4 MB. Some APIs may truncate or reject large payloads.`);
    }

    const timeoutMs = 300_000; // 5 min for large video uploads
    const fetchController = new AbortController();
    const timeoutId = setTimeout(() => {
      fetchController.abort();
    }, timeoutMs);
    context.signal?.addEventListener('abort', () => {
      clearTimeout(timeoutId);
      fetchController.abort();
    }, { once: true });

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
      onLog?.(`[OpenRouter Vision] Request FAILED: ${e instanceof Error ? e.message : String(e)}`);
      const msg = e instanceof Error && e.name === 'AbortError'
        ? 'Request aborted (timeout or cancelled)'
        : String(e);
      return { success: false, error: `OpenRouter request failed: ${msg}` };
    }
    clearTimeout(timeoutId);

    onLog?.(`[OpenRouter Vision] Response status: ${res.status} ${res.statusText}`);

    if (!res.ok) {
      const errText = await res.text();
      onLog?.(`[OpenRouter Vision] Error from OpenRouter: ${res.status} ${errText.slice(0, 500)}`);
      return { success: false, error: `OpenRouter error ${res.status}: ${errText.slice(0, 500)}` };
    }

    const data = await res.json() as any;
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';
    const choiceCount = data?.choices?.length ?? 0;
    onLog?.(`[OpenRouter Vision] Response received. choices: ${choiceCount}, content length: ${text.length} chars`);
    if (text.length === 0 && choiceCount > 0) {
      onLog?.(`[OpenRouter Vision] WARNING: Response has choices but empty content. finish_reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'}`);
    }

    onProgress?.(90, 'Writing output');
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const ext = outputFormat === 'md' ? '.md' : '.txt';
    const outputPath = path.join(outDir, `output${ext}`);
    await fs.writeFile(outputPath, text, 'utf8');
    onLog?.(`Result saved to output${ext}`);

    onProgress?.(100, 'Done');
    onLog?.(`[OpenRouter Vision] === Module complete. Output: ${outputPath} ===`);
    return {
      success: true,
      context: { currentTextOutputPath: outputPath },
    };
  }
}
