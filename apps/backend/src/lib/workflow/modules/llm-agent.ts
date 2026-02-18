import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';
import type { TokenUsage } from './utils.js';
import {
  resolvePromptPlaceholders,
  extractFrames,
  getVideoDuration,
  callOpenRouter,
  isVideoFile,
  isGeminiModel,
} from './utils.js';

// ---------------------------------------------------------------------------
// Agent protocol (hardcoded, not user-editable)
// ---------------------------------------------------------------------------

const AGENT_PROTOCOL = `You are an agent that processes tasks step by step.
You MUST respond with a JSON object on each turn. Available actions:

1. {"action": "think", "content": "your reasoning here"}
   Use this for intermediate analysis, planning, drafting, reviewing.

2. {"action": "read_variable", "variable": "variableName"}
   Read a file from the workflow context. You will receive its content on the next turn.

3. {"action": "done", "content": "your final answer"}
   Produce the final result and stop. Use this when you have completed your analysis.
   Do NOT keep using "think" indefinitely. After a few steps of analysis, you MUST use "done".

IMPORTANT: Always respond with valid JSON only. No text outside the JSON object.`;

// ---------------------------------------------------------------------------
// Default strategy (user can override)
// ---------------------------------------------------------------------------

const DEFAULT_STRATEGY = `Follow this approach:
1. Examine the input and understand the task
2. Plan your approach
3. Think through each aspect step by step (use "think" for 1-3 steps max)
4. When ready, use "done" to produce the final answer. Do not keep thinking indefinitely.`;

// ---------------------------------------------------------------------------
// Module metadata
// ---------------------------------------------------------------------------

export const llmAgentMeta = {
  type: 'llm.agent',
  label: 'LLM Agent (Strategy-driven)',
  description: 'Multimodal strategy-driven agent: analyzes video/text input, reasons in a loop, produces a response.',
  category: 'LLM',
  quickParams: ['model', 'prompt'],
  inputSlots: [
    { key: 'media', label: 'Media (video/image)', kind: 'file' as const },
    { key: 'text', label: 'Text', kind: 'text' as const },
  ],
  outputSlots: [
    { key: 'text', label: 'Text', kind: 'text' as const },
  ],
  paramsSchema: [
    { key: 'prompt', label: 'Task instruction', type: 'prompt' as const,
      default: 'Analyze the provided content and produce a detailed response.' },
    { key: 'strategy', label: 'Agent strategy (step-by-step approach)', type: 'prompt' as const,
      default: DEFAULT_STRATEGY },
    { key: 'apiKeyEnvVar', label: 'API key (env var name)', type: 'string' as const,
      default: 'OPENROUTER_API_KEY' },
    { key: 'model', label: 'Model', type: 'string' as const, default: 'google/gemini-2.0-flash-001' },
    { key: 'maxTokens', label: 'Max tokens per call', type: 'number' as const,
      default: 4096, min: 1, max: 32000 },
    { key: 'temperature', label: 'Temperature', type: 'number' as const,
      default: 0.7, min: 0, max: 2 },
    { key: 'maxIterations', label: 'Max agent iterations', type: 'number' as const,
      default: 10, min: 1, max: 50 },
    { key: 'outputFormat', label: 'Output format', type: 'string' as const, default: 'md',
      options: [
        { value: 'txt', label: 'Plain text (.txt)' },
        { value: 'md', label: 'Markdown (.md)' },
        { value: 'json', label: 'JSON (.json)' },
      ] },
  ],
};

// ---------------------------------------------------------------------------
// Agent action parsing
// ---------------------------------------------------------------------------

interface AgentActionThink { action: 'think'; content: string }
interface AgentActionRead { action: 'read_variable'; variable: string }
interface AgentActionDone { action: 'done'; content: string }
type AgentAction = AgentActionThink | AgentActionRead | AgentActionDone;

function parseAgentAction(raw: string): AgentAction {
  const trimmed = raw.trim();

  // 1. Strict JSON parse
  try {
    const obj = JSON.parse(trimmed);
    if (isValidAction(obj)) return obj;
  } catch { /* continue */ }

  // 2. Extract from markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      const obj = JSON.parse(codeBlockMatch[1].trim());
      if (isValidAction(obj)) return obj;
    } catch { /* continue */ }
  }

  // 3. Regex: find first {...} containing "action"
  const jsonMatch = trimmed.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (isValidAction(obj)) return obj;
    } catch { /* continue */ }
  }

  // 4. Graceful fallback: treat entire response as "done"
  return { action: 'done', content: trimmed };
}

function isValidAction(obj: unknown): obj is AgentAction {
  if (typeof obj !== 'object' || obj === null) return false;
  const a = obj as Record<string, unknown>;
  if (a.action === 'think' && typeof a.content === 'string') return true;
  if (a.action === 'read_variable' && typeof a.variable === 'string') return true;
  if (a.action === 'done' && typeof a.content === 'string') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Helper: read a workflow variable's file content
// ---------------------------------------------------------------------------

async function readVariableContent(
  varName: string,
  variables: Record<string, string>,
): Promise<string> {
  const value = variables[varName];
  if (value === undefined) return `[variable "${varName}" not found]`;
  if (value === '') return `[variable "${varName}" is empty]`;

  const ext = path.extname(value).toLowerCase();
  const textExtensions = new Set(['.txt', '.md', '.json', '.csv', '.srt', '.vtt', '.xml', '.yaml', '.yml']);
  if (textExtensions.has(ext)) {
    try {
      const content = await fs.readFile(value, 'utf8');
      return content;
    } catch {
      return `[could not read file for variable "${varName}": ${value}]`;
    }
  }

  return value;
}

// ---------------------------------------------------------------------------
// Helper: build multimodal content parts for the first message
// ---------------------------------------------------------------------------

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

async function buildFirstMessageContent(opts: {
  prompt: string;
  textContent: string | null;
  mediaPath: string | null;
  model: string;
  variables: Record<string, string>;
  signal?: AbortSignal;
  onLog?: (msg: string) => void;
}): Promise<{ multimodal: ContentPart[]; textFallback: string }> {
  const { prompt, textContent, mediaPath, model, variables, signal, onLog } = opts;

  const varList = Object.keys(variables).join(', ') || '(none)';
  let taskText = `Task: ${prompt}\n\nAvailable variables: ${varList}`;
  if (textContent) {
    taskText += `\n\nText input:\n${textContent}`;
  }

  const parts: ContentPart[] = [{ type: 'text', text: taskText }];
  let textFallback = taskText;

  if (mediaPath) {
    try {
      await fs.access(mediaPath);
    } catch {
      onLog?.(`[Agent] WARNING: Media file not found: ${mediaPath}`);
      return { multimodal: parts, textFallback };
    }

    if (isVideoFile(mediaPath)) {
      if (isGeminiModel(model)) {
        onLog?.('[Agent] Sending video natively (Gemini model)');
        const buf = await fs.readFile(mediaPath);
        onLog?.(`[Agent] Video size: ${(buf.length / 1024).toFixed(1)} KB`);
        parts.push({
          type: 'video_url',
          video_url: { url: `data:video/mp4;base64,${buf.toString('base64')}` },
        });
      } else {
        onLog?.('[Agent] Extracting frames from video...');
        const duration = await getVideoDuration(mediaPath, signal);
        const frameCount = Math.min(Math.max(1, Math.ceil(duration)), 100);
        onLog?.(`[Agent] Duration: ${duration.toFixed(1)}s, extracting ${frameCount} frame(s)`);
        const frames = await extractFrames(mediaPath, frameCount, duration, signal);
        onLog?.(`[Agent] Extracted ${frames.length} frame(s)`);
        for (const b64 of frames) {
          parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
        }
      }
      textFallback += '\n\n[Video frames were provided on this step]';
    } else {
      onLog?.('[Agent] Processing media as image...');
      const buf = await fs.readFile(mediaPath);
      const ext = path.extname(mediaPath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp',
      };
      const mime = mimeMap[ext] ?? 'image/jpeg';
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
      textFallback += '\n\n[Image was provided on this step]';
    }
  }

  return { multimodal: parts, textFallback };
}

// ---------------------------------------------------------------------------
// Module implementation
// ---------------------------------------------------------------------------

export class LlmAgentModule implements WorkflowModule {
  readonly meta = llmAgentMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};

    onLog?.('[Agent] === Module start ===');

    // --- Parse params ---
    const promptTemplate = String(params.prompt ?? llmAgentMeta.paramsSchema[0].default).trim();
    const strategyTemplate = String(params.strategy ?? DEFAULT_STRATEGY).trim();
    const apiKeyEnvVar = String(params.apiKeyEnvVar ?? 'OPENROUTER_API_KEY').trim();
    const model = String(params.model ?? 'google/gemini-2.0-flash-001').trim();
    const maxTokens = Math.max(1, Math.min(32000, Number(params.maxTokens) || 4096));
    const temperature = Math.max(0, Math.min(2, Number(params.temperature) || 0.7));
    const maxIterations = Math.max(1, Math.min(50, Number(params.maxIterations) || 10));
    const outputFormatRaw = String(params.outputFormat ?? 'md').trim().toLowerCase();
    const outputFormat = outputFormatRaw === 'txt' ? 'txt' : outputFormatRaw === 'json' ? 'json' : 'md';

    const apiKey = process.env[apiKeyEnvVar];
    if (!apiKey) {
      onLog?.(`[Agent] ERROR: API key env var "${apiKeyEnvVar}" is not set.`);
      return { success: false, error: `Env variable "${apiKeyEnvVar}" is not set. Add it in Env Manager.` };
    }

    // --- Resolve placeholders in prompt and strategy ---
    const prompt = await resolvePromptPlaceholders(promptTemplate, context.variables);
    const strategy = await resolvePromptPlaceholders(strategyTemplate, context.variables);
    const systemMessage = `${AGENT_PROTOCOL}\n\n--- Strategy ---\n${strategy}`;

    onLog?.(`[Agent] Model: ${model}`);
    onLog?.(`[Agent] Max iterations: ${maxIterations}`);
    onLog?.(`[Agent] Strategy: ${strategy.slice(0, 200)}${strategy.length > 200 ? '...' : ''}`);

    // --- Read inputs ---
    const mediaPath = inputPaths['media'] || null;
    const textPath = inputPaths['text'] || context.currentTextOutputPath || null;
    let textContent: string | null = null;

    if (textPath) {
      try {
        textContent = await fs.readFile(textPath, 'utf8');
        onLog?.(`[Agent] Text input loaded: ${textContent.length} chars from ${textPath}`);
      } catch {
        onLog?.(`[Agent] WARNING: Could not read text input: ${textPath}`);
      }
    }

    if (mediaPath) onLog?.(`[Agent] Media input: ${mediaPath}`);
    if (!mediaPath && !textContent) {
      onLog?.('[Agent] WARNING: No media or text input provided.');
    }

    // --- Build first multimodal message ---
    onProgress?.(5, 'Preparing input');
    const { multimodal, textFallback } = await buildFirstMessageContent({
      prompt, textContent, mediaPath, model,
      variables: context.variables,
      signal: context.signal,
      onLog,
    });

    // Two histories: full (with media on msg 0) and text-only (for subsequent calls)
    type Msg = { role: string; content: unknown };
    const fullHistory: Msg[] = [{ role: 'user', content: multimodal }];
    const textHistory: Msg[] = [{ role: 'user', content: textFallback }];

    const outDir = context.moduleCacheDir ?? context.tempDir;
    let finalAnswer: string | null = null;
    const reasoningSteps: string[] = [];
    const totalUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // --- Agent loop ---
    for (let i = 0; i < maxIterations; i++) {
      if (context.signal?.aborted) {
        onLog?.('[Agent] Aborted by signal');
        return { success: false, error: 'Aborted' };
      }

      const progressPct = 10 + Math.round((i / maxIterations) * 80);
      onProgress?.(progressPct, `Agent step ${i + 1}/${maxIterations}`);

      const messagesToSend = i === 0
        ? [{ role: 'system', content: systemMessage }, ...fullHistory]
        : [{ role: 'system', content: systemMessage }, ...textHistory];

      onLog?.(`[Agent] --- Iteration ${i + 1} (${messagesToSend.length} messages) ---`);

      const result = await callOpenRouter({
        apiKey, model, messages: messagesToSend,
        maxTokens, temperature,
        signal: context.signal,
        timeoutMs: 300_000,
        onLog,
      });

      if ('error' in result) {
        onLog?.(`[Agent] LLM call failed: ${result.error}`);
        return { success: false, error: result.error };
      }

      if (result.usage) {
        totalUsage.prompt_tokens += result.usage.prompt_tokens;
        totalUsage.completion_tokens += result.usage.completion_tokens;
        totalUsage.total_tokens += result.usage.total_tokens;
      }

      const parsed = parseAgentAction(result.text);
      const assistantMsg: Msg = { role: 'assistant', content: result.text };
      fullHistory.push(assistantMsg);
      textHistory.push(assistantMsg);

      if (parsed.action === 'think') {
        const preview = parsed.content.length > 300
          ? `${parsed.content.slice(0, 300)}...`
          : parsed.content;
        onLog?.(`[Agent] Step ${i + 1} [think]: ${preview}`);

        reasoningSteps.push(parsed.content);
        context.onAgentReasoning?.(parsed.content);

        const cont: Msg = { role: 'user', content: 'Continue. If you have completed your analysis, use {"action":"done","content":"..."} to finish.' };
        fullHistory.push(cont);
        textHistory.push(cont);

      } else if (parsed.action === 'read_variable') {
        onLog?.(`[Agent] Step ${i + 1} [read_variable]: "${parsed.variable}"`);

        const varContent = await readVariableContent(parsed.variable, context.variables);
        const varMsg: Msg = { role: 'user', content: `Variable '${parsed.variable}' content:\n${varContent}` };
        fullHistory.push(varMsg);
        textHistory.push(varMsg);

      } else if (parsed.action === 'done') {
        onLog?.(`[Agent] Step ${i + 1} [done]: final answer (${parsed.content.length} chars)`);
        finalAnswer = parsed.content;
        break;
      }
    }

    // --- Force final answer if max iterations reached ---
    if (finalAnswer === null) {
      onLog?.('[Agent] Max iterations reached, forcing final answer...');
      const forceMsg: Msg = {
        role: 'user',
        content: 'You have reached the maximum number of steps. Produce your final answer NOW using {"action":"done","content":"..."}.',
      };
      textHistory.push(forceMsg);

      const forced = await callOpenRouter({
        apiKey, model,
        messages: [{ role: 'system', content: systemMessage }, ...textHistory],
        maxTokens, temperature,
        signal: context.signal,
        timeoutMs: 300_000,
        onLog,
      });

      if ('error' in forced) {
        return { success: false, error: forced.error };
      }

      if (forced.usage) {
        totalUsage.prompt_tokens += forced.usage.prompt_tokens;
        totalUsage.completion_tokens += forced.usage.completion_tokens;
        totalUsage.total_tokens += forced.usage.total_tokens;
      }

      const parsed = parseAgentAction(forced.text);
      finalAnswer = parsed.action === 'read_variable' ? forced.text : parsed.content;
      onLog?.(`[Agent] Forced answer: ${finalAnswer.length} chars`);
    }

    // --- Save reasoning (all think steps) and output ---
    onProgress?.(95, 'Writing output');
    let outputToWrite: string = typeof finalAnswer === 'string' ? (finalAnswer ?? '') : JSON.stringify(finalAnswer);
    // Pretty-print JSON: extract from markdown blocks, unwrap agent response, format
    const tryFormatJson = (raw: string): string | null => {
      let str = raw.trim();
      const codeBlock = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (codeBlock) str = codeBlock[1].trim();
      if (!str.startsWith('{') && !str.startsWith('[')) return null;
      try {
        const parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object' && parsed.action === 'done' && parsed.content !== undefined) {
          return JSON.stringify(parsed.content, null, 2);
        }
        return JSON.stringify(parsed, null, 2);
      } catch {
        return null;
      }
    };
    const formatted = tryFormatJson(outputToWrite);
    if (formatted) {
      outputToWrite = formatted;
      onLog?.('[Agent] Output formatted as pretty JSON');
    }
    const ext = outputFormat === 'txt' ? '.txt' : outputFormat === 'json' ? '.json' : '.md';
    const outputPath = path.join(outDir, `output${ext}`);
    if (outputFormat === 'json') {
      // JSON format: raw pretty JSON; if not JSON, wrap as {"text": "..."}
      if (!formatted) {
        outputToWrite = JSON.stringify({ text: outputToWrite }, null, 2);
      }
    } else if (formatted && ext === '.md') {
      // Wrap JSON in markdown code block so .md preview renders it as code
      outputToWrite = '```json\n' + outputToWrite + '\n```';
    }
    await fs.writeFile(outputPath, outputToWrite, 'utf8');
    onLog?.(`[Agent] Output saved: ${outputPath}`);

    const reasoningPath = path.join(outDir, 'reasoning.md');
    const reasoningContent = reasoningSteps.length > 0
      ? reasoningSteps
          .map((content, idx) => `## Step ${idx + 1}\n\n${content}`)
          .join('\n\n---\n\n')
      : '*Agent produced the final answer directly (no intermediate reasoning steps).*';
    await fs.writeFile(reasoningPath, reasoningContent, 'utf8');
    onLog?.(`[Agent] Reasoning saved: ${reasoningPath}${reasoningSteps.length > 0 ? ` (${reasoningSteps.length} steps)` : ' (direct answer)'}`);

    const metadataPath = path.join(outDir, 'metadata.json');
    const metadata = {
      model: totalUsage.total_tokens > 0 ? model : undefined,
      tokenUsage: totalUsage.total_tokens > 0 ? totalUsage : undefined,
    };
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
    if (totalUsage.total_tokens > 0) {
      onLog?.(`[Agent] Token usage: ${totalUsage.prompt_tokens} prompt + ${totalUsage.completion_tokens} completion = ${totalUsage.total_tokens} total (saved to metadata.json)`);
    }

    onProgress?.(100, 'Done');
    onLog?.('[Agent] === Module complete ===');
    return {
      success: true,
      context: { currentTextOutputPath: outputPath },
    };
  }
}
