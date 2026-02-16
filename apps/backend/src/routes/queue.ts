import { FastifyPluginAsync } from 'fastify';
import { screencastQueue } from '../lib/queue.js';

export const queueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/status', async (request, reply) => {
    try {
      const [counts, waiting, active, failed] = await Promise.all([
        screencastQueue.getJobCounts(),
        screencastQueue.getWaiting(0, 50),
        screencastQueue.getActive(),
        screencastQueue.getFailed(0, 50),
      ]);

      const formatJob = (job: { id?: string; data?: { videoId?: string; url?: string }; timestamp?: number; failedReason?: string }) => ({
        id: job.id,
        videoId: job.data?.videoId?.slice(0, 8),
        url: job.data?.url,
        timestamp: job.timestamp,
        failedReason: job.failedReason,
      });

      return reply.send({
        counts: {
          waiting: counts.waiting ?? counts.wait ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          completed: counts.completed ?? 0,
          delayed: counts.delayed ?? 0,
        },
        waiting: waiting.map(formatJob),
        active: active.map(formatJob),
        failed: failed.map(formatJob),
        strategy: process.env.RECORDING_STRATEGY || 'docker',
      });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to fetch queue status' });
    }
  });
};
