import { FastifyPluginAsync } from 'fastify';
import { db } from '../db/index.js';
import { providerCropPresets, providerTemplates } from '../db/schema/index.js';
import { asc, eq } from 'drizzle-orm';
import z from 'zod';

const providersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /** Detect provider from URL - returns matching template or null */
  fastify.get<{ Querystring: { url: string } }>('/detect', async (request, reply) => {
    const { url } = request.query;
    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'url query param required' });
    }
    let parsed: URL;
    try {
      parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    } catch {
      return reply.send({ provider: null, url: url });
    }
    const host = parsed.hostname.toLowerCase();

    const templates = await db.select().from(providerTemplates);
    const match = templates.find((t) => host.includes(t.urlPattern.toLowerCase()));
    if (!match) {
      return reply.send({ provider: null, url: url });
    }

    return reply.send({
      provider: {
        id: match.id,
        name: match.name,
        playSelectors: (match.playSelectors as string[]) || [],
        endSelectors: (match.endSelectors as string[]) || [],
        idleValueSelector: match.idleValueSelector ?? undefined,
        idleSeconds: match.idleSeconds ?? 40,
        consoleEndPatterns: (match.consoleEndPatterns as string[]) || [],
      },
      url: url,
    });
  });

  /** List all provider templates */
  fastify.get('/', async (request, reply) => {
    const list = await db.select().from(providerTemplates).orderBy(asc(providerTemplates.name));
    return reply.send(list);
  });

  /** Create provider template */
  fastify.post('/', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(1),
      urlPattern: z.string().min(1),
      playSelectors: z.array(z.string()).optional().default([]),
      endSelectors: z.array(z.string()).optional().default([]),
      idleValueSelector: z.string().optional(),
      idleSeconds: z.number().int().min(1).optional().default(40),
      consoleEndPatterns: z.array(z.string()).optional().default([]),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const [created] = await db
      .insert(providerTemplates)
      .values({
        name: body.data.name,
        urlPattern: body.data.urlPattern,
        playSelectors: body.data.playSelectors,
        endSelectors: body.data.endSelectors,
        idleValueSelector: body.data.idleValueSelector,
        idleSeconds: body.data.idleSeconds,
        consoleEndPatterns: body.data.consoleEndPatterns,
      })
      .returning();
    return reply.status(201).send(created);
  });

  /** Update provider template */
  fastify.patch<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      name: z.string().min(1).optional(),
      urlPattern: z.string().min(1).optional(),
      playSelectors: z.array(z.string()).optional(),
      endSelectors: z.array(z.string()).optional(),
      idleValueSelector: z.string().nullable().optional(),
      idleSeconds: z.number().int().min(1).optional(),
      consoleEndPatterns: z.array(z.string()).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const [updated] = await db
      .update(providerTemplates)
      .set({
        ...body.data,
        updatedAt: new Date(),
      })
      .where(eq(providerTemplates.id, id))
      .returning();
    if (!updated) return reply.status(404).send({ error: 'Not found' });
    return reply.send(updated);
  });

  /** Delete provider template */
  fastify.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { id } = request.params;
    const [deleted] = await db.delete(providerTemplates).where(eq(providerTemplates.id, id)).returning();
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return reply.send({ success: true });
  });

  /** Get crop preset for a provider (global, per-provider). Returns null if not set. */
  fastify.get<{ Params: { id: string } }>('/:id/crop', async (request, reply) => {
    const { id } = request.params;
    const [preset] = await db.select()
      .from(providerCropPresets)
      .where(eq(providerCropPresets.providerId, id));
    if (!preset) {
      return reply.send({ left: 0, top: 0, right: 0, bottom: 0 });
    }
    return reply.send({
      left: preset.left,
      top: preset.top,
      right: preset.right,
      bottom: preset.bottom,
    });
  });

  /** Save crop preset for a provider (global, per-provider). */
  fastify.put<{
    Params: { id: string };
    Body: { left: number; top: number; right: number; bottom: number };
  }>('/:id/crop', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      left: z.number().min(0).max(100),
      top: z.number().min(0).max(100),
      right: z.number().min(0).max(100),
      bottom: z.number().min(0).max(100),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.message });
    }
    const provider = await db.query.providerTemplates.findFirst({
      where: eq(providerTemplates.id, id),
    });
    if (!provider) return reply.status(404).send({ error: 'Provider not found' });

    const [preset] = await db.insert(providerCropPresets)
      .values({
        providerId: id,
        left: body.data.left,
        top: body.data.top,
        right: body.data.right,
        bottom: body.data.bottom,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providerCropPresets.providerId,
        set: {
          left: body.data.left,
          top: body.data.top,
          right: body.data.right,
          bottom: body.data.bottom,
          updatedAt: new Date(),
        },
      })
      .returning();
    return reply.send(preset);
  });
};

export default providersRoutes;
