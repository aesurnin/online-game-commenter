import { FastifyPluginAsync } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { screencastQueue, workflowQueue, checkRedisConnection } from '../lib/queue.js';
import { db } from '../db/index.js';
import { projects, videoEntities } from '../db/schema/index.js';
import { getJob as getWorkflowJob, requestCancel } from '../lib/workflow-job-store.js';

type JobItem = {
  id: string;
  type: 'screencast' | 'workflow';
  projectId?: string;
  projectName?: string;
  videoId?: string;
  status: string;
  taskLabel?: string;
  url?: string;
  failedReason?: string;
  progress?: number;
  message?: string;
};

async function enrichWithProjectNames(items: { projectId?: string }[]): Promise<Map<string, string>> {
  const ids = [...new Set(items.map((i) => i.projectId).filter(Boolean))] as string[];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const queueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
  });

  fastify.post<{ Params: { jobId: string } }>('/jobs/:jobId/kill', async (request, reply) => {
    const { jobId } = request.params;

    const screencastJob = await screencastQueue.getJob(jobId);
    if (screencastJob) {
      const state = await screencastJob.getState();
      if (state === 'waiting') {
        await screencastJob.remove();
        return reply.send({ success: true, action: 'removed' });
      }
      if (state === 'active') {
        const videoId = screencastJob.data?.videoId;
        if (!videoId) return reply.status(400).send({ error: 'Job has no videoId' });
        const [video] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
        if (!video) return reply.status(404).send({ error: 'Video not found' });
        const meta = (video.metadata as Record<string, unknown>) || {};
        await db.update(videoEntities)
          .set({ metadata: { ...meta, stopRequested: true } })
          .where(eq(videoEntities.id, videoId));
        return reply.send({ success: true, action: 'stopRequested' });
      }
      return reply.status(400).send({ error: `Cannot kill screencast job in state: ${state}` });
    }

    const workflowJob = await workflowQueue.getJob(jobId);
    if (workflowJob) {
      const state = await workflowJob.getState();
      if (state === 'waiting') {
        await workflowJob.remove();
        return reply.send({ success: true, action: 'removed' });
      }
      if (state === 'active') {
        requestCancel(jobId);
        return reply.send({ success: true, action: 'cancelRequested' });
      }
      return reply.status(400).send({ error: `Cannot kill workflow job in state: ${state}` });
    }

    return reply.status(404).send({ error: 'Job not found' });
  });

  fastify.get('/status', async (request, reply) => {
    const redis = await checkRedisConnection();
    if (!redis.ok) {
      return reply.send({
        redis: 'error',
        redisError: redis.error,
        counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
        waiting: [],
        active: [],
        failed: [],
        completed: [],
        strategy: process.env.RECORDING_STRATEGY || 'puppeteer-stream',
        durationLimit: parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10),
      });
    }

    const [
      screencastWaiting,
      screencastActive,
      screencastCompleted,
      screencastFailed,
      screencastDelayed,
      workflowWaiting,
      workflowActive,
      workflowCompleted,
      workflowFailed,
    ] = await Promise.all([
      screencastQueue.getWaiting(),
      screencastQueue.getActive(),
      screencastQueue.getCompleted(),
      screencastQueue.getFailed(),
      screencastQueue.getDelayed(),
      workflowQueue.getWaiting(),
      workflowQueue.getActive(),
      workflowQueue.getCompleted(),
      workflowQueue.getFailed(),
    ]);

    const toScreencastItem = (j: { id?: string; data?: Record<string, unknown>; failedReason?: string }, status: string): JobItem => ({
      id: String(j.id),
      type: 'screencast',
      projectId: j.data?.projectId as string | undefined,
      videoId: j.data?.videoId as string | undefined,
      status,
      taskLabel: 'Screencast recording',
      url: j.data?.url as string | undefined,
      failedReason: j.failedReason,
    });

    const toWorkflowItem = (j: { id?: string; data?: Record<string, unknown>; failedReason?: string }, status: string): JobItem => {
      const d = j.data as { workflow?: { name: string }; stepIndex?: number } | undefined;
      const taskLabel = d?.stepIndex != null
        ? `Workflow: ${d.workflow?.name ?? '?'} (step ${d.stepIndex + 1})`
        : `Workflow: ${d?.workflow?.name ?? '?'}`;
      return {
        id: String(j.id),
        type: 'workflow',
        projectId: j.data?.projectId as string | undefined,
        videoId: j.data?.videoId as string | undefined,
        status,
        taskLabel,
        failedReason: j.failedReason,
      };
    };

    const screencastItems: JobItem[] = [
      ...screencastWaiting.map((j) => toScreencastItem(j, 'waiting')),
      ...screencastActive.map((j) => toScreencastItem(j, 'active')),
      ...screencastCompleted.map((j) => toScreencastItem(j, 'completed')),
      ...screencastFailed.map((j) => toScreencastItem(j, 'failed')),
    ];

    const workflowItems: JobItem[] = [
      ...workflowWaiting.map((j) => toWorkflowItem(j, 'waiting')),
      ...workflowActive.map((j) => toWorkflowItem(j, 'active')),
      ...workflowCompleted.map((j) => toWorkflowItem(j, 'completed')),
      ...workflowFailed.map((j) => toWorkflowItem(j, 'failed')),
    ];

    const allItemsWithLabels = [...screencastItems, ...workflowItems];
    const projectNames = await enrichWithProjectNames(allItemsWithLabels);

    for (const item of allItemsWithLabels) {
      if (item.projectId) item.projectName = projectNames.get(item.projectId);
    }

    const waiting = allItemsWithLabels.filter((x) => x.status === 'waiting');
    const active = allItemsWithLabels.filter((x) => x.status === 'active');
    const failed = allItemsWithLabels.filter((x) => x.status === 'failed');
    const completed = allItemsWithLabels.filter((x) => x.status === 'completed');

    const workflowJobStates = new Map(
      workflowActive
        .map((j) => [String(j.id), getWorkflowJob(String(j.id))] as const)
        .filter(([, s]) => s) as [string, NonNullable<ReturnType<typeof getWorkflowJob>>][]
    );
    for (const item of active) {
      if (item.type === 'workflow') {
        const state = workflowJobStates.get(item.id);
        if (state) {
          item.progress = state.progress;
          item.message = state.message;
        }
      }
    }

    const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
    return reply.send({
      redis: 'ok',
      counts: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: screencastDelayed.length,
      },
      durationLimit,
      waiting,
      active,
      failed,
      completed,
      strategy: process.env.RECORDING_STRATEGY || 'puppeteer-stream',
    });
  });
};

export default queueRoutes;
