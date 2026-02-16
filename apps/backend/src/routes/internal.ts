import { FastifyPluginAsync } from 'fastify';
import { setFrame } from '../lib/live-preview-store.js';

const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  fastify.post<{ Params: { videoId: string } }>('/live-preview/:videoId', { logLevel: 'silent' }, async (request, reply) => {
    if (!PREVIEW_SECRET || request.headers['x-preview-token'] !== PREVIEW_SECRET) {
      request.log.warn({ videoId: (request.params as { videoId: string }).videoId }, 'Live preview: 401 (bad/missing token)');
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { videoId } = request.params;
    const body = request.body;
    if (!body || !Buffer.isBuffer(body)) {
      return reply.status(400).send({ error: 'Expected JPEG body' });
    }
    setFrame(videoId, body);
    return reply.send({ ok: true });
  });
};
