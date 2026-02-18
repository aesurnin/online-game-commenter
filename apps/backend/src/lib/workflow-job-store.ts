/**
 * In-memory store for workflow job status.
 * Used for progress, logs, and result URL during async execution.
 * Job IDs are BullMQ job IDs when jobs are queued.
 */

export type WorkflowJobStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface WorkflowJobState {
  jobId: string;
  status: WorkflowJobStatus;
  progress: number; // 0-100
  message: string;
  logs: string[];
  /** Agent reasoning steps (llm.agent module) streamed in real-time */
  agentReasoningSteps: string[];
  stepIndex?: number;
  outputUrl?: string;
  /** MIME type of output (e.g. text/plain, text/markdown) when output is a text file */
  outputContentType?: string;
  /** URL to scene.json for Remotion preview (video.render.remotion module) */
  remotionSceneUrl?: string;
  /** Aggregated token usage from all paid-API modules in this run */
  totalTokenUsage?: TokenUsage;
  /** Estimated cost in USD (OpenRouter pricing) */
  totalCostUsd?: number;
  /** Total execution time in milliseconds */
  totalExecutionTimeMs?: number;
  error?: string;
  stepResults?: { index: number; moduleId: string; success: boolean; error?: string }[];
  projectId?: string;
  videoId?: string;
  workflowId?: string;
  workflowName?: string;
}

const jobs = new Map<string, WorkflowJobState>();
const cancelRequested = new Set<string>();

export function createJob(overrides?: Partial<WorkflowJobState>): { jobId: string; state: WorkflowJobState } {
  const jobId = overrides?.jobId ?? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const state: WorkflowJobState = {
    jobId,
    status: 'pending',
    progress: 0,
    message: '',
    logs: [],
    agentReasoningSteps: [],
    ...overrides,
  };
  jobs.set(jobId, state);
  return { jobId, state };
}

export function requestCancel(jobId: string): void {
  cancelRequested.add(jobId);
}

export function isCancelRequested(jobId: string): boolean {
  return cancelRequested.has(jobId);
}

export function clearCancelRequest(jobId: string): void {
  cancelRequested.delete(jobId);
}

export function getJob(jobId: string): WorkflowJobState | undefined {
  return jobs.get(jobId);
}

export function listJobs(): WorkflowJobState[] {
  return Array.from(jobs.values());
}

export function updateJob(
  jobId: string,
  update: Partial<Pick<WorkflowJobState, 'status' | 'progress' | 'message' | 'outputUrl' | 'outputContentType' | 'totalTokenUsage' | 'totalCostUsd' | 'totalExecutionTimeMs' | 'error' | 'stepResults'>>
) {
  const state = jobs.get(jobId);
  if (state) Object.assign(state, update);
}

export function appendJobLog(jobId: string, message: string) {
  const state = jobs.get(jobId);
  if (state) state.logs.push(message);
}

export function appendAgentReasoning(jobId: string, content: string) {
  const state = jobs.get(jobId);
  if (state) state.agentReasoningSteps.push(content);
}
