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
async function extractFrames(videoPath: string, count: number, durationSec: number): Promise<string[]> {
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
async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', '-i', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
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

export const openrouterVisionMeta = {
  type: 'llm.openrouter.vision',
  label: 'OpenRouter Vision (Video + Prompt)',
  description: 'Send video frames and a prompt to OpenRouter; returns text. Prompt is stored in the workflow.',
  category: 'LLM',
  quickParams: ['model', 'prompt'],
  inputSlots: [{ key: 'video', label: 'Video', kind: 'video' as const }],
  outputSlots: [{ key: 'text', label: 'Text', kind: 'text' as const }],
  paramsSchema: [
    { key: 'prompt', label: 'Prompt', type: 'prompt' as const, default: 'Describe what happens in this video.' },
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const, default: 'OPENROUTER_API_KEY' },
    { key: 'model', label: 'Model (e.g. openai/gpt-4o)', type: 'string' as const, default: 'openai/gpt-4o' },
    { key: 'maxFrames', label: 'Max frames to send', type: 'number' as const, default: 8, min: 1, max: 20 },
    { key: 'maxTokens', label: 'Max tokens', type: 'number' as const, default: 1024, min: 1, max: 32000 },
    { key: 'temperature', label: 'Temperature', type: 'number' as const, default: 0.7, min: 0, max: 2 },
    { key: 'outputFormat', label: 'Output file format', type: 'string' as const, default: 'txt', options: [{ value: 'txt', label: 'Plain text (.txt)' }, { value: 'md', label: 'Markdown (.md)' }] },
  ],
};

export class OpenRouterVisionModule implements WorkflowModule {
  readonly meta = openrouterVisionMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPath = context.currentVideoPath;
    const promptTemplate = String(params.prompt ?? 'Describe what happens in this video.').trim();
    const prompt = await resolvePromptPlaceholders(promptTemplate, context.variables);
    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'OPENROUTER_API_KEY').trim();
    const model = String(params.model ?? 'openai/gpt-4o').trim();
    const maxFrames = Math.max(1, Math.min(20, Number(params.maxFrames) ?? 8));
    const maxTokens = Math.max(1, Math.min(32000, Number(params.maxTokens) ?? 1024));
    const temperature = Math.max(0, Math.min(2, Number(params.temperature) ?? 0.7));
    const outputFormat = String(params.outputFormat ?? 'txt').trim() === 'md' ? 'md' : 'txt';

    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      return { success: false, error: `Env variable "${apiKeyEnvVar}" is not set. Add it in Env Manager.` };
    }

    try {
      await fs.access(inputPath);
    } catch {
      return { success: false, error: `Input video not found: ${inputPath}` };
    }

    onLog?.('Getting video duration...');
    let durationSec = 0;
    try {
      durationSec = await getVideoDuration(inputPath);
      onLog?.(`Video duration: ${durationSec.toFixed(1)}s`);
    } catch (e) {
      onLog?.(`Could not get duration: ${e}`);
    }

    onProgress?.(10, 'Extracting frames');
    let frames: string[];
    try {
      frames = await extractFrames(inputPath, maxFrames, durationSec);
      onLog?.(`Extracted ${frames.length} frame(s)`);
    } catch (e) {
      return { success: false, error: `Frame extraction failed: ${e}` };
    }

    if (frames.length === 0) {
      return { success: false, error: 'No frames could be extracted from the video' };
    }

    onProgress?.(40, 'Calling OpenRouter');
    const content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [
      { type: 'text', text: prompt },
    ];
    for (const b64 of frames) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${b64}` },
      });
    }

    const body = {
      model,
      messages: [{ role: 'user' as const, content }],
      max_tokens: maxTokens,
      temperature,
    };

    let res: Response;
    try {
      res = await fetch(OPENROUTER_BASE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { success: false, error: `OpenRouter request failed: ${e}` };
    }

    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `OpenRouter error ${res.status}: ${errText.slice(0, 500)}` };
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = data?.choices?.[0]?.message?.content?.trim() ?? '';

    onProgress?.(90, 'Writing output');

    const outDir = context.moduleCacheDir ?? context.tempDir;
    const ext = outputFormat === 'md' ? '.md' : '.txt';
    const outputPath = path.join(outDir, `output${ext}`);
    await fs.writeFile(outputPath, text, 'utf8');

    onProgress?.(100, 'Done');
    onLog?.('OpenRouter response written to output file');

    return {
      success: true,
      context: {
        currentTextOutputPath: outputPath,
      },
    };
  }
}
