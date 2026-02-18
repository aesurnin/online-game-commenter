import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { WorkflowDefinition, WorkflowContext, WorkflowModuleDef } from './types.js';
import { getModule } from './registry.js';
import { getObjectFromR2 } from '../r2.js';

const MODULE_ID_FILE = '.module-id';

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
): Promise<{ name: string; type: 'file' | 'dir'; size?: number }[]> {
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
  const result: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.module-id') continue;
    const entry: { name: string; type: 'file' | 'dir'; size?: number } = {
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
    };
    if (e.isFile()) {
      try {
        const stat = await fs.stat(path.join(dir, e.name));
        entry.size = stat.size;
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
  /** Called periodically to check if execution should be aborted */
  onCheckCancel?: () => boolean;
  /** Optional: abort signal to stop long-running operations */
  signal?: AbortSignal;
}

export interface RunResult {
  success: boolean;
  error?: string;
  context?: WorkflowContext;
  stepResults?: { index: number; moduleId: string; success: boolean; error?: string }[];
  /** When the last run step produced a text file (e.g. OpenRouter); worker uses this to set outputUrl to cache file URL */
  lastStepOutput?: { kind: 'text'; path: string; cacheFolderName: string; relativePath: string };
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
  const { projectId, videoId, sourceVideoKey, workflow, stepIndex, previousContext, onProgress, onLog, onCheckCancel, signal } = options;
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
  const stepResults: RunResult['stepResults'] = [];
  let lastStepOutput: RunResult['lastStepOutput'];

  for (let i = startIdx; i < endIdx; i++) {
    if (onCheckCancel?.()) {
      onLog?.('Workflow cancelled by user');
      return { success: false, error: 'Cancelled by user', context, stepResults };
    }
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

    context.inputPaths = {};
    if (def.inputs) {
      for (const [slotKey, varName] of Object.entries(def.inputs)) {
        const p = variables[varName];
        if (p && typeof p === 'string') context.inputPaths[slotKey] = p;
      }
    }

    const stepNum = i + 1;
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
      if (result.context.variables) {
        Object.assign(variables, result.context.variables);
      }
      Object.assign(context, { ...result.context, variables: context.variables });
    }
    onLog?.(`[Step ${stepNum}] Completed`);
  }

  onProgress?.(100, 'Done');
  onLog?.('Workflow completed successfully');
  return { success: true, context, stepResults, lastStepOutput };
}
