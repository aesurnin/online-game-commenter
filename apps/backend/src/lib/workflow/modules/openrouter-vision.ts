import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';
import {
  resolvePromptPlaceholders,
  extractFrames,
  getVideoDuration,
  readImageOrVideoFrame,
  callOpenRouter,
} from './utils.js';

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
    onLog?.(`[OpenRouter Vision] Sending request to OpenRouter (model: ${model})...`);

    const result = await callOpenRouter({
      apiKey,
      model,
      messages: [{ role: 'user', content }],
      maxTokens,
      temperature,
      signal: context.signal,
      timeoutMs: 300_000,
      onLog,
    });

    if ('error' in result) {
      return { success: false, error: result.error };
    }

    const text = result.text;
    const usage = result.usage;

    onProgress?.(90, 'Writing output');
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const ext = outputFormat === 'md' ? '.md' : '.txt';
    const outputPath = path.join(outDir, `output${ext}`);
    await fs.writeFile(outputPath, text, 'utf8');
    onLog?.(`Result saved to output${ext}`);

    if (usage && usage.total_tokens > 0) {
      const metadataPath = path.join(outDir, 'metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify({ model, tokenUsage: usage }, null, 2), 'utf8');
      onLog?.(`[OpenRouter Vision] Token usage: ${usage.prompt_tokens} prompt + ${usage.completion_tokens} completion = ${usage.total_tokens} total`);
    }

    onProgress?.(100, 'Done');
    onLog?.(`[OpenRouter Vision] === Module complete. Output: ${outputPath} ===`);
    return {
      success: true,
      context: { currentTextOutputPath: outputPath },
    };
  }
}
