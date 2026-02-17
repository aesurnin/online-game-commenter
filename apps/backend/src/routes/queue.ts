import { FastifyPluginAsync } from 'fastify';
import { screencastQueue } from '../lib/queue.js';

const queueRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) return reply.status(401).send({ error: 'Unauthorized' });
  });

  fastify.get('/status', async (request, reply) => {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      screencastQueue.getWaiting(),
      screencastQueue.getActive(),
      screencastQueue.getCompleted(),
      screencastQueue.getFailed(),
      screencastQueue.getDelayed(),
    ]);
    const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
    return reply.send({
      counts: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        delayed: delayed.length,
      },
      durationLimit,
      waiting: waiting.map((j) => ({ id: j.id, videoId: j.data?.videoId, url: j.data?.url })),
      active: active.map((j) => ({ id: j.id, videoId: j.data?.videoId, url: j.data?.url })),
      failed: failed.map((j) => ({ id: j.id, videoId: j.data?.videoId, failedReason: j.failedReason })),
      strategy: process.env.RECORDING_STRATEGY || 'puppeteer-stream',
    });
  });
};

export default queueRoutes;
