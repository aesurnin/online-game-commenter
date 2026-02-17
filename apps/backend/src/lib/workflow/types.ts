/**
 * Workflow engine types.
 * Workflows are stored as JSON in S3 (workflows/ prefix).
 */

/** Single module step in a workflow definition */
export interface WorkflowModuleDef {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  /** Where to write outputs: { slotKey: variableName } */
  outputs?: Record<string, string>;
  /** Where to read inputs from: { slotKey: variableName } */
  inputs?: Record<string, string>;
}

/** Full workflow definition (JSON stored in S3) */
export interface WorkflowDefinition {
  id?: string;
  name: string;
  modules: WorkflowModuleDef[];
}

/** Schema for module params (used by UI to render config form) */
export interface ModuleParamSchema {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean' | 'prompt';
  default?: unknown;
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

/** Slot kind for input/output */
export type SlotKind = 'video' | 'text' | 'file';

/** Input/output slot definition */
export interface ModuleSlotDef {
  key: string;
  label: string;
  kind: SlotKind;
}

/** Module metadata (for registry and UI) */
export interface ModuleMeta {
  type: string;
  label: string;
  description?: string;
  /** Category for grouping in the add-step picker (e.g. Video, LLM) */
  category?: string;
  paramsSchema?: ModuleParamSchema[];
  /** Keys of params to show in quick (collapsed) view */
  quickParams?: string[];
  inputSlots?: ModuleSlotDef[];
  outputSlots?: ModuleSlotDef[];
}

/** Runtime context passed between modules */
export interface WorkflowContext {
  projectId: string;
  videoId: string;
  /** Path to current video file (local temp). Kept for backward compat; prefer variables. */
  currentVideoPath: string;
  /** R2 key of the base/source video */
  sourceVideoKey: string;
  /** Workflow variables: variableName -> path or text value */
  variables: Record<string, string>;
  /** Generated assets (TTS, images, etc.) keyed by module id */
  assets: Record<string, string>;
  /** Evolving Remotion manifest for final render */
  remotionManifest: Record<string, unknown>;
  /** Temp directory for this run */
  tempDir: string;
  /** This module's cache directory for outputs */
  moduleCacheDir?: string;
  /** Path to text output file (e.g. .txt/.md) produced by this module; used when output slot kind is 'text' */
  currentTextOutputPath?: string;
  /** Optional: report progress (0-100) and message during module execution */
  onProgress?: (percent: number, message: string) => void;
  /** Optional: append log line */
  onLog?: (message: string) => void;
}

/** Result of running a single module */
export interface ModuleRunResult {
  success: boolean;
  error?: string;
  /** Updated context (or partial updates merged by runner) */
  context?: Partial<WorkflowContext>;
}

/** Interface that all workflow modules implement */
export interface WorkflowModule {
  readonly meta: ModuleMeta;
  run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult>;
}
