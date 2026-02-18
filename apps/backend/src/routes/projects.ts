import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { db } from '../db/index.js';
import { projects, providerTemplates, videoEntities } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import z from 'zod';
import { uploadToR2, deleteFromR2, deletePrefixFromR2, getPresignedUrl, listObjectsWithMetaFromR2, streamObjectFromR2 } from '../lib/r2.js';
import fs from 'fs';
import { cleanupWorkflowModuleCache, ensureWorkflowModuleCacheDirs, listWorkflowModuleCache, listWorkflowCacheFolderContents, getWorkflowCacheFilePath } from '../lib/workflow/runner.js';
import { addScreencastJob, removeScreencastJobByVideoId } from '../lib/queue.js';
import { getFrame, clearFrame } from '../lib/live-preview-store.js';
import { getVideoLogs } from '../lib/video-logs-store.js';

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
            (out as Record<string, unknown>).streamUrl = `/api/projects/${id}/videos/${v.id}/stream`;
          } catch {
            // skip playUrl on error
          }
        }
        return out;
      })
    );
    return reply.send(withUrls);
  });

  /** Stream video from R2 with Range support (for seeking without full download) */
  fastify.get<{ Params: { id: string; videoId: string } }>('/:id/videos/:videoId/stream', async (request, reply) => {
    const { id, videoId } = request.params;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const sourceKey = video.sourceUrl;
    if (!sourceKey?.startsWith('projects/')) {
      return reply.status(400).send({ error: 'Video has no R2 source' });
    }

    const rangeHeader = request.headers.range;
    try {
      const { body, contentLength, contentType, contentRange, statusCode } = await streamObjectFromR2(
        sourceKey,
        rangeHeader
      );

      reply.status(statusCode);
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', String(contentLength));
      reply.header('Accept-Ranges', 'bytes');
      if (contentRange) reply.header('Content-Range', contentRange);

      return reply.send(body);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to stream video' });
    }
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
    const buffer = await data.toBuffer();

    const [video] = await db.insert(videoEntities).values({
      projectId: id,
      status: 'uploading',
      sourceUrl: null,
    }).returning();

    const key = `projects/${id}/${video.id}/video${ext}`;
    try {
      await uploadToR2(key, buffer);
      await db.update(videoEntities)
        .set({ status: 'ready', sourceUrl: key })
        .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
    } catch (err) {
      await db.update(videoEntities)
        .set({ status: 'failed', metadata: { error: String(err) } })
        .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
      return reply.status(500).send({ error: 'Upload failed' });
    }

    const [updated] = await db.select().from(videoEntities)
      .where(and(eq(videoEntities.id, video.id), eq(videoEntities.projectId, id)));
    const out = { ...(updated ?? video) };
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

  fastify.patch('/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const schema = z.object({ displayName: z.string().optional() });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);

    const updates: Record<string, unknown> = {};
    if (body.data.displayName !== undefined) updates.displayName = body.data.displayName;
    if (Object.keys(updates).length === 0) return reply.send(video);

    const [updated] = await db.update(videoEntities)
      .set(updates as Record<string, string>)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)))
      .returning();
    return reply.send(updated ?? video);
  });

  fastify.get('/:id/videos/:videoId/logs', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const logs = getVideoLogs(videoId);
    return reply.send({ logs });
  });

  fastify.get('/:id/videos/:videoId/assets', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const prefix1 = `projects/${projectId}/${videoId}/`;
    const prefix2 = `projects/${projectId}/videos/${videoId}/`;
    const [list1, list2] = await Promise.all([
      listObjectsWithMetaFromR2(prefix1),
      listObjectsWithMetaFromR2(prefix2),
    ]);
    const all = [...list1, ...list2];
    const assets = await Promise.all(
      all.map(async (obj) => {
        const ct = obj.contentType ?? '';
        const isVideo = ct.startsWith('video/');
        const isImage = ct.startsWith('image/');
        const isText = ct.startsWith('text/') || /\.(txt|md)$/i.test(obj.key);
        let previewUrl: string | undefined;
        if (isVideo || isImage || isText) {
          try {
            previewUrl = await getPresignedUrl(obj.key, 3600);
          } catch {
            // skip
          }
        }
        const shortKey = obj.key.startsWith(prefix1)
          ? obj.key.slice(prefix1.length)
          : obj.key.startsWith(prefix2)
            ? obj.key.slice(prefix2.length)
            : obj.key;
        return {
          key: obj.key,
          shortKey,
          size: obj.size,
          lastModified: obj.lastModified?.toISOString(),
          contentType: obj.contentType,
          previewUrl,
        };
      })
    );
    return reply.send({ assets });
  });

  fastify.delete('/:id/videos/:videoId/assets', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({ key: z.string().min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const key = body.data.key;
    const allowedPrefix1 = `projects/${projectId}/${videoId}/`;
    const allowedPrefix2 = `projects/${projectId}/videos/${videoId}/`;
    if (!key.startsWith(allowedPrefix1) && !key.startsWith(allowedPrefix2)) {
      return reply.status(403).send({ error: 'Asset key not allowed for this video' });
    }

    await deleteFromR2(key);
    return reply.send({ success: true });
  });

  fastify.post('/:id/videos/:videoId/workflow-cache/ensure', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({
      items: z.array(z.object({ moduleId: z.string(), moduleType: z.string() })).min(1),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    await ensureWorkflowModuleCacheDirs(projectId, videoId, body.data.items);
    return reply.send({ success: true });
  });

  fastify.get('/:id/videos/:videoId/workflow-cache', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const folders = await listWorkflowModuleCache(projectId, videoId);
    return reply.send({ workflowCache: folders });
  });

  fastify.get<{
    Params: { id: string; videoId: string; folderName: string };
    Querystring: { path?: string };
  }>('/:id/videos/:videoId/workflow-cache/:folderName/contents', async (request, reply) => {
    const { id: projectId, videoId, folderName } = request.params;
    const { path: subPath } = request.query;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    try {
      const entries = await listWorkflowCacheFolderContents(projectId, videoId, folderName, subPath);
      return reply.send({ entries });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Invalid') || msg.includes('ENOENT')) {
        return reply.status(400).send({ error: msg });
      }
      throw err;
    }
  });

  fastify.get<{
    Params: { id: string; videoId: string; folderName: string };
    Querystring: { path: string };
  }>('/:id/videos/:videoId/workflow-cache/:folderName/file', async (request, reply) => {
    const { id: projectId, videoId, folderName } = request.params;
    const { path: filePath } = request.query;
    if (!filePath || typeof filePath !== 'string') {
      return reply.status(400).send({ error: 'path query is required' });
    }
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    try {
      const { absolutePath, contentType } = await getWorkflowCacheFilePath(projectId, videoId, folderName, filePath);
      const stream = fs.createReadStream(absolutePath);
      return reply
        .header('Content-Type', contentType)
        .header('Accept-Ranges', 'bytes')
        .send(stream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Invalid') || msg.includes('Not a file') || msg.includes('ENOENT')) {
        return reply.status(400).send({ error: msg });
      }
      throw err;
    }
  });

  fastify.post('/:id/videos/:videoId/workflow-cache/cleanup', async (request, reply) => {
    const { id: projectId, videoId } = request.params as { id: string; videoId: string };
    const schema = z.object({ moduleIds: z.array(z.string()).min(1) });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    await cleanupWorkflowModuleCache(projectId, videoId, body.data.moduleIds);
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

    try {
      const prefix = `projects/${id}/${videoId}/`;
      await deletePrefixFromR2(prefix);
      if (deleted.sourceUrl?.startsWith('projects/') && !deleted.sourceUrl.includes(`/${videoId}/`)) {
        await deleteFromR2(deleted.sourceUrl);
      }
    } catch (err) {
      request.log.warn({ err, videoId, projectId: id }, 'R2 delete failed');
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
    try {
      await deletePrefixFromR2(`projects/${id}/`);
    } catch (err) {
      request.log.warn({ err, projectId: id }, 'R2 project delete failed');
    }
    return reply.send({ success: true });
  });
};

export default projectsRoutes;
