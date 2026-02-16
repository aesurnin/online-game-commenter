import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { db } from '../db/index.js';
import { projects, videoEntities } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import z from 'zod';
import { uploadToR2, deleteFromR2, getPresignedUrl } from '../lib/r2.js';

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
        if (v.sourceUrl && !v.sourceUrl.startsWith('/')) {
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
      status: 'ready',
      sourceUrl: body.data.url,
    }).returning();

    return reply.status(201).send(video);
  });

  fastify.delete('/:id/videos/:videoId', async (request, reply) => {
    const { id, videoId } = request.params as { id: string; videoId: string };
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, id), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Not found' });

    const [deleted] = await db.delete(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, id)))
      .returning();

    if (!deleted) return reply.status(404).send({ error: 'Video not found' });

    if (deleted.sourceUrl && !deleted.sourceUrl.startsWith('/')) {
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
