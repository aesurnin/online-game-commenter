import { FastifyPluginAsync } from 'fastify';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import z from 'zod';
import { db } from '../db/index.js';
import { contentLibraryItems } from '../db/schema/index.js';
import { uploadToR2, deleteFromR2, streamObjectFromR2 } from '../lib/r2.js';

const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.ogg'];
const MIME_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

const contentLibraryRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /** Get unique tags from all audio items (for random-by-tag filter) */
  fastify.get('/audio/tags', async (request, reply) => {
    const items = await db.select({ tags: contentLibraryItems.tags }).from(contentLibraryItems).where(eq(contentLibraryItems.type, 'audio'));
    const tagSet = new Set<string>();
    for (const i of items) {
      const tags = (i.tags ?? []) as string[];
      for (const t of tags) if (typeof t === 'string' && t.trim()) tagSet.add(t.trim());
    }
    return reply.send([...tagSet].sort());
  });

  /** List audio items. Query: ?forSelect=1 (lightweight for dropdown), ?tags=tag1,tag2 */
  fastify.get<{ Querystring: { forSelect?: string; tags?: string } }>('/audio', async (request, reply) => {
    const { forSelect, tags } = request.query;
    const tagList = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;

    let items = await db.select().from(contentLibraryItems).where(eq(contentLibraryItems.type, 'audio'));

    if (tagList?.length) {
      items = items.filter((item) => {
        const itemTags = (item.tags ?? []) as string[];
        return tagList.some((t) => itemTags.includes(t));
      });
    }

    if (forSelect === '1') {
      return reply.send(items.map((i) => ({ id: i.id, name: i.name, tags: i.tags ?? [] })));
    }

    return reply.send(items);
  });

  /** Upload audio items (multipart: one or more files). Names from original filenames. */
  fastify.post('/audio', async (request, reply) => {
    const uploaded: typeof contentLibraryItems.$inferSelect[] = [];
    const parts = request.parts();

    for await (const part of parts) {
      if (part.type !== 'file' || !part.filename) continue;

      const ext = path.extname(part.filename).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) {
        request.log.warn({ filename: part.filename }, 'Skipping invalid format');
        continue;
      }

      const name = part.filename.replace(/\.[^.]+$/, '') || part.filename;
      const buffer = await part.toBuffer();
      const mimeType = MIME_MAP[ext.slice(1)] ?? 'application/octet-stream';

      const [item] = await db.insert(contentLibraryItems).values({
        type: 'audio',
        name,
        tags: [],
        r2Key: '',
        mimeType,
        ownerId: request.user!.id,
      }).returning();

      if (!item) continue;

      const r2Key = `content-library/audio/${item.id}${ext}`;
      try {
        await uploadToR2(r2Key, buffer, mimeType);
        await db.update(contentLibraryItems)
          .set({ r2Key })
          .where(eq(contentLibraryItems.id, item.id));
        const [updated] = await db.select().from(contentLibraryItems).where(eq(contentLibraryItems.id, item.id));
        if (updated) uploaded.push(updated);
      } catch (err) {
        await db.delete(contentLibraryItems).where(eq(contentLibraryItems.id, item.id));
        request.log.error(err, `Upload failed for ${part.filename}`);
      }
    }

    if (uploaded.length === 0) {
      return reply.status(400).send({ error: 'No valid audio files uploaded. Use mp3, wav, m4a, or ogg' });
    }

    return reply.status(201).send(uploaded);
  });

  /** Get single item metadata */
  fastify.get<{ Params: { id: string } }>('/audio/:id', async (request, reply) => {
    const { id } = request.params;
    const [item] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, id), eq(contentLibraryItems.type, 'audio'))
    );
    if (!item) return reply.status(404).send({ error: 'Not found' });
    return reply.send(item);
  });

  /** Update name, tags */
  fastify.patch<{ Params: { id: string }; Body: { name?: string; tags?: string[] } }>('/audio/:id', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).optional(),
      tags: z.array(z.string()).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);

    const [existing] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, id), eq(contentLibraryItems.type, 'audio'))
    );
    if (!existing) return reply.status(404).send({ error: 'Not found' });

    const updates: { name?: string; tags?: string[] } = {};
    if (body.data.name != null) updates.name = body.data.name;
    if (body.data.tags != null) updates.tags = body.data.tags;

    if (Object.keys(updates).length === 0) return reply.send(existing);

    const [updated] = await db.update(contentLibraryItems)
      .set(updates)
      .where(eq(contentLibraryItems.id, id))
      .returning();
    return reply.send(updated ?? existing);
  });

  /** Delete item + R2 object */
  fastify.delete<{ Params: { id: string } }>('/audio/:id', async (request, reply) => {
    const { id } = request.params;
    const [item] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, id), eq(contentLibraryItems.type, 'audio'))
    );
    if (!item) return reply.status(404).send({ error: 'Not found' });

    try {
      await deleteFromR2(item.r2Key);
    } catch (err) {
      request.log.warn({ err, r2Key: item.r2Key }, 'R2 delete failed');
    }
    await db.delete(contentLibraryItems).where(eq(contentLibraryItems.id, id));
    return reply.send({ success: true });
  });

  /** Stream/download file (for preview, workflow worker uses getObjectFromR2 directly) */
  fastify.get<{ Params: { id: string } }>('/audio/:id/file', async (request, reply) => {
    const { id } = request.params;
    const [item] = await db.select().from(contentLibraryItems).where(
      and(eq(contentLibraryItems.id, id), eq(contentLibraryItems.type, 'audio'))
    );
    if (!item) return reply.status(404).send({ error: 'Not found' });

    const rangeHeader = request.headers.range;
    try {
      const { body, contentLength, contentType, contentRange, statusCode } = await streamObjectFromR2(
        item.r2Key,
        rangeHeader
      );
      reply.status(statusCode);
      reply.header('Content-Type', item.mimeType ?? contentType);
      reply.header('Content-Length', String(contentLength));
      reply.header('Accept-Ranges', 'bytes');
      if (contentRange) reply.header('Content-Range', contentRange);
      return reply.send(body);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: 'Failed to stream file' });
    }
  });
};

export default contentLibraryRoutes;
