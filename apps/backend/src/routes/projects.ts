import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { db } from '../db/index.js';
import { projects, providerTemplates, videoEntities } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import z from 'zod';
import { uploadToR2, deleteFromR2, getPresignedUrl } from '../lib/r2.js';
import { addScreencastJob, removeScreencastJobByVideoId } from '../lib/queue.js';
import { getFrame, clearFrame } from '../lib/live-preview-store.js';

async function resolveProviderForUrl(url: string) {
  let host: string;
  try {
    host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  const templates = await db.select().from(providerTemplates);
  return templates.find((t) => host.includes(t.urlPattern.toLowerCase())) ?? null;
}

const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.get('/', async (request, reply) => {
    const list = await db.query.projects.findMany({
      where: eq(projects.ownerId, request.user!.id),
    });
    return reply.send(list);
  });

  fastify.post('/', async (request, reply) => {
    const schema = z.object({ name: z.string().min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(body.error);
    }
    const [project] = await db.insert(projects).values({
      name: body.data.name,
      ownerId: request.user!.id,
    }).returning();
    return reply.status(201).send(project);
  });

  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    return reply.send(project);
  });

  fastify.get('/:id/videos', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const videos = await db.query.videoEntities.findMany({
      where: eq(videoEntities.projectId, id),
    });
    const withUrls = await Promise.all(
      videos.map(async (v) => {
        const out = { ...v };
        if (v.sourceUrl?.startsWith('projects/')) {
          try {
            (out as Record<string, unknown>).playUrl = await getPresignedUrl(
              v.sourceUrl,
              3600
            );
          } catch {
            // skip playUrl on error
          }
        }
        return out;
      })
    );
    return reply.send(withUrls);
  });

  fastify.post('/:id/videos/upload', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const data = await request.file();
    if (!data) return reply.status(400).send({ error: 'No file' });

    const ext = path.extname(data.filename) || '.mp4';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    const buffer = await data.toBuffer();

    const key = `projects/${id}/${filename}`;
    await uploadToR2(key, buffer);

    const [video] = await db.insert(videoEntities).values({
      projectId: id,
      status: 'ready',
      sourceUrl: key,
    }).returning();

    const out = { ...video };
    try {
      (out as Record<string, unknown>).playUrl = await getPresignedUrl(key, 3600);
    } catch {
      // ignore
    }

    return reply.status(201).send(out);
  });

  fastify.post('/:id/videos/url', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const schema = z.object({ url: z.string().url() });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'Invalid URL' });

    const [video] = await db.insert(videoEntities).values({
      projectId: id,
      status: 'processing',
      sourceUrl: body.data.url,
    }).returning();

    const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
    const provider = await resolveProviderForUrl(body.data.url);

    let endSelectors: string[] | undefined;
    let playSelectors: string[] | undefined;
    let idleValueSelector: string | undefined;
    let idleSeconds: number | undefined;
    let consoleEndPatterns: string[] | undefined;

    if (provider) {
      playSelectors = (provider.playSelectors as string[])?.length ? (provider.playSelectors as string[]) : undefined;
      endSelectors = (provider.endSelectors as string[])?.length ? (provider.endSelectors as string[]) : undefined;
      idleValueSelector = provider.idleValueSelector ?? undefined;
      idleSeconds = provider.idleSeconds ?? 40;
      consoleEndPatterns = (provider.consoleEndPatterns as string[])?.length ? (provider.consoleEndPatterns as string[]) : undefined;
    }

    if (!playSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_PLAY_SELECTORS;
        if (s) playSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!endSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_END_SELECTORS;
        if (s) endSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!idleValueSelector) {
      const s = process.env.SCREENCAST_IDLE_SELECTOR;
      if (s) idleValueSelector = s;
    }
    if (idleSeconds == null) {
      const s = process.env.SCREENCAST_IDLE_SECONDS;
      if (s) idleSeconds = parseInt(s, 10);
    }
    if (!consoleEndPatterns?.length) {
      try {
        const s = process.env.SCREENCAST_CONSOLE_END_PATTERNS;
        if (s) consoleEndPatterns = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }

    if (body.data.url.includes('bgaming-network.com') && !provider) {
      if (!playSelectors?.length) playSelectors = ['#playBtn', 'button#playBtn', '[class*="replay"]'];
      if (!idleValueSelector) idleValueSelector = '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]';
      if (idleSeconds == null) idleSeconds = 40;
    }

    await addScreencastJob({
      projectId: id,
      videoId: video.id,
      url: body.data.url,
      durationLimit,
      endSelectors,
      playSelectors,
      idleValueSelector,
      idleSeconds,
      consoleEndPatterns,
    });

    return reply.status(201).send(video);
  });

  fastify.get('/:id/videos/:videoId/live-preview', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    const buffer = getFrame(videoId);
    if (!buffer) {
      return reply.status(204).send();
    }
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'no-store').send(buffer);
  });

  fastify.post('/:id/videos/:videoId/stop', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'processing') {
      return reply.status(400).send({ error: 'Video is not being recorded' });
    }

    const meta = (video.metadata as Record<string, unknown>) || {};
    await db.update(videoEntities)
      .set({ metadata: { ...meta, stopRequested: true } })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));

    request.log.info({ videoId: videoId.slice(0, 8) }, 'Stop requested, worker will pick up');
    return reply.send({ success: true });
  });

  fastify.post('/:id/videos/:videoId/restart', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'failed') {
      return reply.status(400).send({ error: 'Only failed recordings can be restarted' });
    }
    const url = video.sourceUrl;
    if (!url) {
      return reply.status(400).send({ error: 'No source URL to restart' });
    }

    const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
    const provider = await resolveProviderForUrl(url);

    let endSelectors: string[] | undefined;
    let playSelectors: string[] | undefined;
    let idleValueSelector: string | undefined;
    let idleSeconds: number | undefined;
    let consoleEndPatterns: string[] | undefined;

    if (provider) {
      playSelectors = (provider.playSelectors as string[])?.length ? (provider.playSelectors as string[]) : undefined;
      endSelectors = (provider.endSelectors as string[])?.length ? (provider.endSelectors as string[]) : undefined;
      idleValueSelector = provider.idleValueSelector ?? undefined;
      idleSeconds = provider.idleSeconds ?? 40;
      consoleEndPatterns = (provider.consoleEndPatterns as string[])?.length ? (provider.consoleEndPatterns as string[]) : undefined;
    }
    if (!playSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_PLAY_SELECTORS;
        if (s) playSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!endSelectors?.length) {
      try {
        const s = process.env.SCREENCAST_END_SELECTORS;
        if (s) endSelectors = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (!idleValueSelector) {
      const s = process.env.SCREENCAST_IDLE_SELECTOR;
      if (s) idleValueSelector = s;
    }
    if (idleSeconds == null) {
      const s = process.env.SCREENCAST_IDLE_SECONDS;
      if (s) idleSeconds = parseInt(s, 10);
    }
    if (!consoleEndPatterns?.length) {
      try {
        const s = process.env.SCREENCAST_CONSOLE_END_PATTERNS;
        if (s) consoleEndPatterns = JSON.parse(s) as string[];
      } catch { /* ignore */ }
    }
    if (url.includes('bgaming-network.com') && !provider) {
      if (!playSelectors?.length) playSelectors = ['#playBtn', 'button#playBtn', '[class*="replay"]'];
      if (!idleValueSelector) idleValueSelector = '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]';
      if (idleSeconds == null) idleSeconds = 40;
    }

    await db.update(videoEntities)
      .set({ status: 'processing', metadata: {} })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));

    await addScreencastJob({
      projectId: id,
      videoId: video.id,
      url,
      durationLimit,
      endSelectors,
      playSelectors,
      idleValueSelector,
      idleSeconds,
      consoleEndPatterns,
    });

    return reply.send({ success: true });
  });

  fastify.post('/:id/videos/:videoId/cancel', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });
    if (video.status !== 'processing') {
      return reply.status(400).send({ error: 'Video is not being recorded' });
    }

    await db.update(videoEntities)
      .set({ status: 'cancelled', metadata: { cancelledAt: new Date().toISOString() } })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    await removeScreencastJobByVideoId(videoId);
    clearFrame(videoId);
    return reply.send({ success: true });
  });

  fastify.delete('/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    // If recording, signal worker to stop before deleting
    await db.update(videoEntities)
      .set({ status: 'cancelled' })
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id), eq(videoEntities.status, 'processing')));

    const [deleted] = await db.delete(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)))
      .returning();

    if (!deleted) return reply.status(404).send({ error: 'Video not found' });

    if (deleted.sourceUrl?.startsWith('projects/')) {
      try {
        await deleteFromR2(deleted.sourceUrl);
      } catch {
        // log but don't fail the delete
      }
    }

    return reply.send({ success: true });
  });

  fastify.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({ name: z.string().min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);
    const [updated] = await db.update(projects)
      .set({ name: body.data.name, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (!updated || updated.ownerId !== request.user!.id) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.send(updated);
  });

  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const [deleted] = await db.delete(projects)
      .where(eq(projects.id, id))
      .returning();
    if (!deleted || deleted.ownerId !== request.user!.id) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.send({ success: true });
  });
};

export default projectsRoutes;
