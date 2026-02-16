import { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { setFrame } from '../lib/live-preview-store.js';
import { uploadToR2 } from '../lib/r2.js';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';

const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';

export const internalRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser('video/mp4', { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 }, (req, body, done) => {
    done(null, body);
  });
  fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 500 * 1024 * 1024 }, (req, body, done) => {
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

  fastify.post<{ Params: { videoId: string } }>('/upload-video/:videoId', { logLevel: 'silent' }, async (request, reply) => {
    if (!PREVIEW_SECRET || request.headers['x-preview-token'] !== PREVIEW_SECRET) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const { videoId } = request.params;
    const projectId = request.headers['x-project-id'] as string | undefined;
    if (!projectId) {
      return reply.status(400).send({ error: 'X-Project-Id header required' });
    }
    const body = request.body;
    if (!body || !Buffer.isBuffer(body)) {
      return reply.status(400).send({ error: 'Expected MP4 body' });
    }
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
    const key = `projects/${projectId}/${filename}`;
    await uploadToR2(key, body, 'video/mp4');
    await db.update(videoEntities)
      .set({ status: 'ready', sourceUrl: key, metadata: {} })
      .where(eq(videoEntities.id, videoId));
    return reply.send({ ok: true, key });
  });
};
