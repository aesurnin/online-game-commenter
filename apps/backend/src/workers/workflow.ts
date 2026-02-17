import fs from 'fs/promises';
import { Worker, Job } from 'bullmq';
import { runWorkflow } from '../lib/workflow/runner.js';
import { uploadToR2, getPresignedUrl } from '../lib/r2.js';
import {
  createJob,
  updateJob,
  appendJobLog,
  isCancelRequested,
  clearCancelRequest,
} from '../lib/workflow-job-store.js';
import type { WorkflowJobData } from '../lib/queue.js';
import type { WorkflowDefinition } from '../lib/workflow/types.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const redisOpts = parseRedisUrl(REDIS_URL);

async function processWorkflowJob(job: Job<WorkflowJobData>) {
  const { projectId, videoId, workflowId, workflow, stepIndex, sourceVideoKey } = job.data;
  const jobId = job.id!;

  const { state } = createJob({
    jobId,
    status: 'active',
    projectId,
    videoId,
    workflowId,
    workflowName: workflow.name,
    stepIndex,
  });

  try {
    const result = await runWorkflow({
      projectId,
      videoId,
      sourceVideoKey,
      workflow: workflow as WorkflowDefinition,
      stepIndex,
      onProgress: (pct, msg) => {
        state.progress = pct;
        state.message = msg;
      },
      onLog: (msg) => appendJobLog(jobId, msg),
      onCheckCancel: () => isCancelRequested(jobId),
    });

    clearCancelRequest(jobId);

    if (!result.success) {
      updateJob(jobId, {
        status: 'failed',
        error: result.error,
        stepResults: result.stepResults,
      });
      throw new Error(result.error);
    }

    if (result.context?.currentVideoPath) {
      try {
        const buf = await fs.readFile(result.context.currentVideoPath);
        const suffix = stepIndex != null ? `step-${stepIndex}.mp4` : 'full.mp4';
        const key = `projects/${projectId}/videos/${videoId}/workflow-output/${suffix}`;
        await uploadToR2(key, buf, 'video/mp4');
        const outputUrl = await getPresignedUrl(key, 3600);
        updateJob(jobId, { outputUrl });
      } catch (e) {
        appendJobLog(jobId, `Upload failed: ${e}`);
      }
    }

    updateJob(jobId, {
      status: 'completed',
      progress: 100,
      stepResults: result.stepResults,
    });
  } catch (err) {
    clearCancelRequest(jobId);
    const error = err instanceof Error ? err.message : String(err);
    if (!state.error) {
      updateJob(jobId, { status: 'failed', error });
    }
    throw err;
  }
}

export function startWorkflowWorker(): Worker<WorkflowJobData> {
  const worker = new Worker<WorkflowJobData>(
    'workflow',
    processWorkflowJob,
    {
      connection: { ...redisOpts, maxRetriesPerRequest: null },
      concurrency: 2,
    }
  );

  worker.on('completed', (job) => {
    console.log('[WorkflowWorker] Job completed', job.id);
  });

  worker.on('failed', (job, err) => {
    console.error('[WorkflowWorker] Job failed', job?.id, err.message);
  });

  worker.on('error', (err) => {
    console.error('[WorkflowWorker] Worker error', err);
  });

  console.log('[WorkflowWorker] Started');
  return worker;
}
