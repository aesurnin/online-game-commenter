import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { WorkflowDefinition, WorkflowContext, WorkflowModuleDef } from './types.js';
import { getModule } from './registry.js';
import { getObjectFromR2 } from '../r2.js';
import { resolveWorkflowVariables } from './variable-resolver.js';
import { ensurePricingLoaded, calculateCost } from './openrouter-pricing.js';

const MODULE_ID_FILE = '.module-id';
const METADATA_FILE = 'metadata.json';

interface TokenUsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

interface ModuleMetadata {
  tokenUsage?: TokenUsageData;
  model?: string;
  /** Direct cost in USD. Modules (ElevenLabs, etc.) that don't use tokens write this themselves. */
  costUsd?: number;
}

async function readModuleMetadata(cacheDir: string): Promise<ModuleMetadata | null> {
  try {
    const p = path.join(cacheDir, METADATA_FILE);
    const data = await fs.readFile(p, 'utf8');
    const parsed = JSON.parse(data) as { tokenUsage?: TokenUsageData; model?: string; costUsd?: number };
    const hasTokenUsage = parsed?.tokenUsage && typeof parsed.tokenUsage.prompt_tokens === 'number' && typeof parsed.tokenUsage.completion_tokens === 'number';
    const hasCostUsd = typeof parsed?.costUsd === 'number' && parsed.costUsd > 0;
    if (!hasTokenUsage && !hasCostUsd) return null;
    const result: ModuleMetadata = {};
    if (hasTokenUsage) {
      const u = parsed!.tokenUsage!;
      result.tokenUsage = {
        prompt_tokens: u.prompt_tokens,
        completion_tokens: u.completion_tokens,
        total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
      };
      result.model = typeof parsed.model === 'string' ? parsed.model : undefined;
    }
    if (hasCostUsd) result.costUsd = parsed!.costUsd!;
    return result;
  } catch {
    /* no metadata or invalid */
  }
  return null;
}

async function writeExecutionTimeToMetadata(cacheDir: string, executionTimeMs: number): Promise<void> {
  try {
    const p = path.join(cacheDir, METADATA_FILE);
    let data: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(p, 'utf8');
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* no file or invalid, start fresh */
    }
    data.executionTimeMs = executionTimeMs;
    await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function getWorkflowCacheBase(): string {
  const base = process.env.WORKFLOW_CACHE_BASE;
  if (base) return base;
  return path.join(process.cwd(), 'workflow-cache');
}

/** Human-readable folder name: video.compress + m_123_abc -> video-compress-abc */
function getCacheFolderName(moduleType: string, moduleId: string): string {
  const typeSlug = moduleType.replace(/\./g, '-');
  const shortId = moduleId.split('_').pop()?.slice(0, 8) ?? moduleId.slice(-8);
  return `${typeSlug}-${shortId}`;
}

/** Resolve cache dir for a module: find by .module-id or by legacy folder name (moduleId) */
async function resolveModuleCacheDir(videoDir: string, moduleId: string): Promise<string | null> {
  const entries = await fs.readdir(videoDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dirPath = path.join(videoDir, e.name);
    const metaPath = path.join(dirPath, MODULE_ID_FILE);
    try {
      const stored = await fs.readFile(metaPath, 'utf8');
      if (stored.trim() === moduleId) return dirPath;
    } catch {
      if (e.name === moduleId) return dirPath;
    }
  }
  return null;
}

/** Ensure cache directories exist for given modules. Creates empty dirs with readable names. */
export async function ensureWorkflowModuleCacheDirs(
  projectId: string,
  videoId: string,
  items: { moduleId: string; moduleType: string }[]
): Promise<void> {
  const cacheBase = getWorkflowCacheBase();
  const videoDir = path.join(cacheBase, projectId, videoId);
  await fs.mkdir(videoDir, { recursive: true });
  for (const { moduleId, moduleType } of items) {
    const folderName = getCacheFolderName(moduleType, moduleId);
    const dir = path.join(videoDir, folderName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, MODULE_ID_FILE), moduleId, 'utf8');
  }
}

/** Read metadata.json from a workflow cache folder. Returns null if missing or invalid. */
export async function readWorkflowModuleMetadata(
  projectId: string,
  videoId: string,
  folderName: string
): Promise<{ executionTimeMs?: number; costUsd?: number; tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string } | null> {
  const cacheBase = getWorkflowCacheBase();
  const p = path.join(cacheBase, projectId, videoId, folderName, METADATA_FILE);
  try {
    const raw = await fs.readFile(p, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const result: { executionTimeMs?: number; costUsd?: number; tokenUsage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; model?: string } = {};
    if (typeof data.executionTimeMs === 'number' && data.executionTimeMs > 0) result.executionTimeMs = data.executionTimeMs;
    if (typeof data.costUsd === 'number' && data.costUsd > 0) result.costUsd = data.costUsd;
    if (data.tokenUsage && typeof data.tokenUsage === 'object') {
      const u = data.tokenUsage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      if (typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
        result.tokenUsage = {
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          total_tokens: u.total_tokens ?? u.prompt_tokens + u.completion_tokens,
        };
      }
    }
    if (typeof data.model === 'string') result.model = data.model;
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** List workflow cache module folders for a video. Returns folderName and moduleId. */
export async function listWorkflowModuleCache(
  projectId: string,
  videoId: string
): Promise<{ folderName: string; moduleId: string }[]> {
  const cacheBase = getWorkflowCacheBase();
  const videoDir = path.join(cacheBase, projectId, videoId);
  try {
    const entries = await fs.readdir(videoDir, { withFileTypes: true });
    const result: { folderName: string; moduleId: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(videoDir, e.name, MODULE_ID_FILE);
      try {
        const moduleId = (await fs.readFile(metaPath, 'utf8')).trim();
        result.push({ folderName: e.name, moduleId });
      } catch {
        result.push({ folderName: e.name, moduleId: e.name });
      }
    }
    return result;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

/** List contents of a workflow cache folder. subPath is optional (e.g. "subdir" or "a/b"). */
export async function listWorkflowCacheFolderContents(
  projectId: string,
  videoId: string,
  folderName: string,
  subPath?: string
): Promise<{ name: string; type: 'file' | 'dir'; size?: number; lastModified?: string }[]> {
  if (folderName.includes('/') || folderName.includes('..') || folderName.startsWith('.')) {
    throw new Error('Invalid folder name');
  }
  if (subPath?.includes('..') || subPath?.startsWith('/')) {
    throw new Error('Invalid path');
  }
  const cacheBase = getWorkflowCacheBase();
  const dir = subPath
    ? path.join(cacheBase, projectId, videoId, folderName, subPath)
    : path.join(cacheBase, projectId, videoId, folderName);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result: { name: string; type: 'file' | 'dir'; size?: number; lastModified?: string }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.module-id') continue;
    const entry: { name: string; type: 'file' | 'dir'; size?: number; lastModified?: string } = {
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    };
    if (e.isFile()) {
      try {
        const stat = await fs.stat(path.join(dir, e.name));
        entry.size = stat.size;
        entry.lastModified = stat.mtime.toISOString();
      } catch {
        /* ignore */
      }
    }
    result.push(entry);
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.txt': 'text/plain', '.md': 'text/markdown',
};

/** Resolve absolute path for a file in workflow cache. filePath is relative to folder (e.g. "output.mp4" or "subdir/file.mp4"). */
export async function getWorkflowCacheFilePath(
  projectId: string,
  videoId: string,
  folderName: string,
  filePath: string
): Promise<{ absolutePath: string; contentType: string }> {
  if (folderName.includes('/') || folderName.includes('..') || folderName.startsWith('.')) {
    throw new Error('Invalid folder name');
  }
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('Invalid path');
  }
  const cacheBase = getWorkflowCacheBase();
  const absolutePath = path.join(cacheBase, projectId, videoId, folderName, filePath);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error('Not a file');
  return { absolutePath, contentType };
}

/** Remove cache directories for given module IDs. Safe to call with non-existent paths. */
export async function cleanupWorkflowModuleCache(
  projectId: string,
  videoId: string,
  moduleIds: string[]
): Promise<void> {
  const cacheBase = getWorkflowCacheBase();
  const videoDir = path.join(cacheBase, projectId, videoId);
  try {
    const entries = await fs.readdir(videoDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dirPath = path.join(videoDir, e.name);
      const metaPath = path.join(dirPath, MODULE_ID_FILE);
      let matches = false;
      try {
        const stored = (await fs.readFile(metaPath, 'utf8')).trim();
        matches = moduleIds.includes(stored);
      } catch {
        matches = moduleIds.includes(e.name);
      }
      if (matches) {
        await fs.rm(dirPath, { recursive: true });
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
}

export interface RunOptions {
  projectId: string;
  videoId: string;
  sourceVideoKey: string;
  workflow: WorkflowDefinition;
  /** If set, run only this step (0-based). Previous steps must have been run (context provided or re-run). */
  stepIndex?: number;
  /** Serialized context from previous run (for step-by-step). Optional. */
  previousContext?: Partial<WorkflowContext>;
  /** Callbacks for progress/logging during async run */
  onProgress?: (percent: number, message: string) => void;
  onLog?: (message: string) => void;
  /** Called when starting each step (0-based index) - allows UI to show current step */
  onStepStart?: (stepIndex: number) => void;
  /** Stream agent reasoning steps (llm.agent module) */
  onAgentReasoning?: (content: string) => void;
  /** Called periodically to check if execution should be aborted */
  onCheckCancel?: () => boolean;
  /** Optional: abort signal to stop long-running operations */
  signal?: AbortSignal;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface RunResult {
  success: boolean;
  error?: string;
  context?: WorkflowContext;
  stepResults?: { index: number; moduleId: string; success: boolean; error?: string }[];
  /** When the last run step produced a text file (e.g. OpenRouter); worker uses this to set outputUrl to cache file URL */
  lastStepOutput?: { kind: 'text'; path: string; cacheFolderName: string; relativePath: string };
  /** Aggregated token usage from all paid-API modules (llm-agent, openrouter-vision, etc.) */
  totalTokenUsage?: TokenUsage;
  /** Estimated cost in USD based on OpenRouter pricing */
  totalCostUsd?: number;
  /** Total execution time in milliseconds across all steps */
  totalExecutionTimeMs?: number;
}

/** Download video from R2 to local temp and return path */
export async function downloadVideoToTemp(
  sourceKey: string,
  tempDir: string
): Promise<string> {
  const buffer = await getObjectFromR2(sourceKey);
  const ext = path.extname(sourceKey) || '.mp4';
  const localPath = path.join(tempDir, `source${ext}`);
  await fs.writeFile(localPath, buffer);
  return localPath;
}

export async function runWorkflow(options: RunOptions): Promise<RunResult> {
  const { projectId, videoId, sourceVideoKey, workflow, stepIndex, previousContext, onProgress, onLog, onAgentReasoning, onStepStart, onCheckCancel, signal } = options;
  const tempDir = previousContext?.tempDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-'));
  const modules = workflow.modules;

  onLog?.('Starting workflow...');
  onProgress?.(0, 'Downloading source video');

  let currentVideoPath: string;
  if (previousContext?.currentVideoPath) {
    try {
      await fs.access(previousContext.currentVideoPath);
      currentVideoPath = previousContext.currentVideoPath;
      onLog?.('Using cached source from previous step');
    } catch {
      currentVideoPath = await downloadVideoToTemp(sourceVideoKey, tempDir);
      onLog?.('Source video downloaded');
    }
  } else {
    currentVideoPath = await downloadVideoToTemp(sourceVideoKey, tempDir);
    onLog?.('Source video downloaded');
  }

  const prevVars = previousContext?.variables;
  const variables: Record<string, string> =
    prevVars && typeof prevVars === 'object'
      ? Object.fromEntries(Object.entries(prevVars).filter(([, v]) => typeof v === 'string') as [string, string][])
      : {};

  variables.source = currentVideoPath;

  const context: WorkflowContext = {
    projectId,
    videoId,
    currentVideoPath,
    sourceVideoKey,
    variables,
    assets: previousContext?.assets ?? {},
    remotionManifest: previousContext?.remotionManifest ?? {},
    tempDir,
    onProgress,
    onLog,
    signal,
  };

  const cacheBase = getWorkflowCacheBase();
  const startIdx = stepIndex ?? 0;
  const endIdx = stepIndex != null ? stepIndex + 1 : modules.length;

  // Resolve variables from central "table" (workflow def + cache). All modules look up here.
  // When running a single step, load variables from previous steps. Safe for variable renames.
  const resolved = await resolveWorkflowVariables(projectId, videoId, workflow, {
    sourcePath: currentVideoPath,
    endExclusive: stepIndex != null ? stepIndex : 0,
    existing: variables,
    onLog,
  });
  Object.assign(variables, resolved);

  const stepResults: RunResult['stepResults'] = [];
  let lastStepOutput: RunResult['lastStepOutput'];
  const totalTokenUsage: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let totalCostUsd = 0;
  let totalExecutionTimeMs = 0;

  await ensurePricingLoaded();

  for (let i = startIdx; i < endIdx; i++) {
    if (onCheckCancel?.()) {
      onLog?.('Workflow cancelled by user');
      return { success: false, error: 'Cancelled by user', context, stepResults };
    }
    onStepStart?.(i);
    const def = modules[i];
    const mod = getModule(def.type);
    if (!mod) {
      stepResults.push({ index: i, moduleId: def.id, success: false, error: `Unknown module type: ${def.type}` });
      return { success: false, error: `Unknown module type: ${def.type}`, stepResults };
    }

    const videoDir = path.join(cacheBase, projectId, videoId);
    await fs.mkdir(videoDir, { recursive: true });
    let moduleCacheDir = await resolveModuleCacheDir(videoDir, def.id);
    if (!moduleCacheDir) {
      const folderName = getCacheFolderName(def.type, def.id);
      moduleCacheDir = path.join(videoDir, folderName);
      await fs.mkdir(moduleCacheDir, { recursive: true });
      await fs.writeFile(path.join(moduleCacheDir, MODULE_ID_FILE), def.id, 'utf8');
    }
    context.moduleCacheDir = moduleCacheDir;

    const inputVar = def.inputs?.video;
    if (inputVar && variables[inputVar]) {
      context.currentVideoPath = variables[inputVar];
    } else if (i === 0) {
      context.currentVideoPath = variables.source;
    }

    const stepNum = i + 1;
    const stepStartTime = Date.now();
    context.onAgentReasoning = def.type === 'llm.agent' ? onAgentReasoning : undefined;
    context.inputPaths = {};
    if (def.inputs) {
      for (const [slotKey, varName] of Object.entries(def.inputs)) {
        const p = variables[varName];
        if (p && typeof p === 'string') {
          context.inputPaths[slotKey] = p;
          onLog?.(`[Runner] Step ${stepNum} input: ${slotKey} <- "${varName}" = "${p.slice(0, 60)}${p.length > 60 ? '...' : ''}"`);
        } else {
          onLog?.(`[Runner] Step ${stepNum} input: ${slotKey} <- "${varName}" (not set or empty)`);
        }
      }
    }
    const totalSteps = endIdx - startIdx;
    const baseProgress = totalSteps > 0 ? (i / totalSteps) * 100 : 0;
    onLog?.(`[Step ${stepNum}] ${mod.meta.label} (${def.type})`);
    onProgress?.(baseProgress, `Running step ${stepNum}: ${mod.meta.label}`);

    const result = await mod.run(context, def.params ?? {});
    stepResults.push({
      index: i,
      moduleId: def.id,
      success: result.success,
      error: result.error,
    });

    if (!result.success) {
      onLog?.(`[Step ${stepNum}] Failed: ${result.error}`);
      return { success: false, error: result.error, context, stepResults };
    }

    const stepEndTime = Date.now();
    const executionTimeMs = stepEndTime - stepStartTime;

    if (result.context) {
      if (result.context.currentVideoPath) {
        context.currentVideoPath = result.context.currentVideoPath;
      }
      const outputVideoVar = def.outputs?.video;
      if (outputVideoVar && result.context.currentVideoPath) {
        variables[outputVideoVar] = result.context.currentVideoPath;
      }
      const outputTextVar = def.outputs?.text;
      if (outputTextVar && result.context.currentTextOutputPath) {
        variables[outputTextVar] = result.context.currentTextOutputPath;
        if (i === endIdx - 1) {
          const cacheFolderName = path.basename(moduleCacheDir);
          lastStepOutput = {
            kind: 'text',
            path: result.context.currentTextOutputPath,
            cacheFolderName,
            relativePath: path.basename(result.context.currentTextOutputPath),
          };
        }
      }
      const outputAudioVar = def.outputs?.audio;
      if (outputAudioVar && result.context.currentAudioPath) {
        variables[outputAudioVar] = result.context.currentAudioPath;
      }
      if (result.context.variables) {
        Object.assign(variables, result.context.variables);
      }
      Object.assign(context, { ...result.context, variables: context.variables });
    }

    totalExecutionTimeMs += executionTimeMs;
    await writeExecutionTimeToMetadata(moduleCacheDir, executionTimeMs);
    onLog?.(`[Step ${stepNum}] Execution time: ${(executionTimeMs / 1000).toFixed(1)}s`);

    const meta = await readModuleMetadata(moduleCacheDir);
    if (meta) {
      let stepCost = 0;
      if (meta.costUsd != null && meta.costUsd > 0) {
        stepCost = meta.costUsd;
        totalCostUsd += stepCost;
        onLog?.(`[Step ${stepNum}] Cost: $${stepCost.toFixed(4)} (module-reported)`);
      } else if (meta.tokenUsage && (meta.tokenUsage.total_tokens ?? meta.tokenUsage.prompt_tokens + meta.tokenUsage.completion_tokens) > 0) {
        const u = meta.tokenUsage;
        const stepTotal = u.total_tokens ?? u.prompt_tokens + u.completion_tokens;
        totalTokenUsage.prompt_tokens += u.prompt_tokens;
        totalTokenUsage.completion_tokens += u.completion_tokens;
        totalTokenUsage.total_tokens += stepTotal;
        const modelId = meta.model ?? 'unknown';
        stepCost = calculateCost(modelId, u.prompt_tokens, u.completion_tokens);
        totalCostUsd += stepCost;
        onLog?.(`[Step ${stepNum}] Token usage: +${stepTotal} (total: ${totalTokenUsage.total_tokens})${stepCost > 0 ? `, cost: $${stepCost.toFixed(4)}` : ''}`);
      }
    }
    onLog?.(`[Step ${stepNum}] Completed`);
  }

  onProgress?.(100, 'Done');
  onLog?.('Workflow completed successfully');
  if (totalTokenUsage.total_tokens > 0) {
    onLog?.(`[Workflow] Total tokens: ${totalTokenUsage.prompt_tokens} prompt + ${totalTokenUsage.completion_tokens} completion = ${totalTokenUsage.total_tokens} total${totalCostUsd > 0 ? `, cost: $${totalCostUsd.toFixed(4)}` : ''}`);
  }
  if (totalExecutionTimeMs > 0) {
    onLog?.(`[Workflow] Total execution time: ${(totalExecutionTimeMs / 1000).toFixed(1)}s`);
  }
  return {
    success: true,
    context,
    stepResults,
    lastStepOutput,
    totalTokenUsage: totalTokenUsage.total_tokens > 0 ? totalTokenUsage : undefined,
    totalCostUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
    totalExecutionTimeMs: totalExecutionTimeMs > 0 ? totalExecutionTimeMs : undefined,
  };
}
