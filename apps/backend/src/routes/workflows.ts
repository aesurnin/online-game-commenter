import { FastifyPluginAsync } from 'fastify';
import z from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import * as workflowService from '../lib/workflow/service.js';
import { listModules } from '../lib/workflow/registry.js';
import { createJob, getJob } from '../lib/workflow-job-store.js';
import { addWorkflowJob } from '../lib/queue.js';

const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /** List available module types (for editor) - must be before :id */
  fastify.get('/modules/list', async (request, reply) => {
    return reply.send(listModules());
  });

  /** Get job status (progress, logs, outputUrl) */
  fastify.get<{ Params: { jobId: string } }>('/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const job = getJob(jobId);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    return reply.send(job);
  });

  /** List all workflows (from S3) */
  fastify.get('/', async (request, reply) => {
    const list = await workflowService.listWorkflows();
    return reply.send(list);
  });

  /** Get single workflow */
  fastify.get('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const def = await workflowService.getWorkflow(id);
    if (!def) return reply.status(404).send({ error: 'Workflow not found' });
    return reply.send(def);
  });

  /** Create or update workflow */
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      name: z.string().min(1),
      modules: z.array(z.object({
        id: z.string(),
        type: z.string(),
        params: z.record(z.unknown()).optional(),
        inputs: z.record(z.string()).optional(),
        outputs: z.record(z.string()).optional(),
      })),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);
    await workflowService.saveWorkflow(id, { ...body.data, id });
    return reply.send({ success: true });
  });

  /** Delete workflow */
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await workflowService.deleteWorkflow(id);
    return reply.send({ success: true });
  });

  /** Run full workflow on a video */
  fastify.post<{
    Params: { id: string };
    Body: { projectId: string; videoId: string; workflow?: { name: string; modules: unknown[] } };
  }>('/:id/run', async (request, reply) => {
    const { id } = request.params;
    const schema = z.object({
      projectId: z.string().uuid(),
      videoId: z.string().uuid(),
      workflow: z.object({ name: z.string(), modules: z.array(z.any()) }).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);

    const { projectId, videoId, workflow: bodyWorkflow } = body.data;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const sourceKey = video.sourceUrl;
    if (!sourceKey?.startsWith('projects/')) {
      return reply.status(400).send({ error: 'Video has no R2 source (upload or record first)' });
    }

    let workflow = bodyWorkflow ?? (await workflowService.getWorkflow(id));
    if (!workflow) return reply.status(404).send({ error: 'Workflow not found' });

    const { id: jobId } = await addWorkflowJob({
      projectId,
      videoId,
      workflowId: id,
      workflow,
      sourceVideoKey: sourceKey,
    });

    createJob({
      jobId,
      status: 'pending',
      projectId,
      videoId,
      workflowId: id,
      workflowName: workflow.name,
    });

    return reply.status(202).send({ jobId });
  });

  /** Run single step (runs all previous steps first to build context) */
  fastify.post<{
    Params: { id: string; stepIndex: string };
    Body: { projectId: string; videoId: string; workflow?: { name: string; modules: unknown[] } };
  }>('/:id/step/:stepIndex', async (request, reply) => {
    const { id, stepIndex: stepIndexStr } = request.params;
    const stepIndex = parseInt(stepIndexStr, 10);
    if (isNaN(stepIndex) || stepIndex < 0) {
      return reply.status(400).send({ error: 'Invalid stepIndex' });
    }

    const schema = z.object({
      projectId: z.string().uuid(),
      videoId: z.string().uuid(),
      workflow: z.object({ name: z.string(), modules: z.array(z.any()) }).optional(),
    });
    const body = schema.safeParse(request.body);
    if (!body.success) return reply.status(400).send(body.error);

    const { projectId, videoId, workflow: bodyWorkflow } = body.data;
    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const sourceKey = video.sourceUrl;
    if (!sourceKey?.startsWith('projects/')) {
      return reply.status(400).send({ error: 'Video has no R2 source' });
    }

    let workflow = bodyWorkflow ?? (await workflowService.getWorkflow(id));
    if (!workflow) return reply.status(404).send({ error: 'Workflow not found' });
    if (stepIndex >= workflow.modules.length) {
      return reply.status(400).send({ error: 'Step index out of range' });
    }

    const { id: jobId } = await addWorkflowJob({
      projectId,
      videoId,
      workflowId: id,
      workflow,
      stepIndex,
      sourceVideoKey: sourceKey,
    });

    createJob({
      jobId,
      status: 'pending',
      projectId,
      videoId,
      workflowId: id,
      workflowName: workflow.name,
      stepIndex,
    });

    return reply.status(202).send({ jobId });
  });

  /** Test crop on a single frame. Accepts crop as margin %: left, top, right, bottom (0–100 each). */
  fastify.post<{
    Params: { id: string };
    Body: { projectId: string; videoId: string; left: number; top: number; right: number; bottom: number; time?: number };
  }>('/:id/test-crop', async (request, reply) => {
    const body = request.body;
    const { projectId, videoId, time = 0 } = body;
    const left = Math.max(0, Math.min(100, body.left ?? 0));
    const top = Math.max(0, Math.min(100, body.top ?? 0));
    const right = Math.max(0, Math.min(100, body.right ?? 0));
    const bottom = Math.max(0, Math.min(100, body.bottom ?? 0));
    const widthPct = Math.max(0, 100 - left - right);
    const heightPct = Math.max(0, 100 - top - bottom);

    const project = await db.query.projects.findFirst({
      where: (p, { and, eq }) => and(eq(p.id, projectId), eq(p.ownerId, request.user!.id)),
    });
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const [video] = await db.select()
      .from(videoEntities)
      .where(and(eq(videoEntities.id, videoId), eq(videoEntities.projectId, projectId)));
    if (!video) return reply.status(404).send({ error: 'Video not found' });

    const sourceKey = video.sourceUrl;
    if (!sourceKey) return reply.status(400).send({ error: 'Video source not found' });

    const { getPresignedUrl } = await import('../lib/r2.js');
    const sourceUrl = await getPresignedUrl(sourceKey, 3600);

    const { spawn } = await import('child_process');

    async function getVideoDimensions(url: string): Promise<{ width: number; height: number }> {
      return new Promise((resolve, reject) => {
        const proc = spawn('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height',
          '-of', 'csv=p=0',
          '-i', url,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout?.on('data', (c) => { out += c.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code !== 0) return reject(new Error(`ffprobe exited ${code}`));
          const [w, h] = out.trim().split(',').map(Number);
          if (!w || !h) return reject(new Error('Could not parse dimensions'));
          resolve({ width: w, height: h });
        });
      });
    }

    try {
      const dims = await getVideoDimensions(sourceUrl);
      const x = Math.round((left / 100) * dims.width) & ~1;
      const y = Math.round((top / 100) * dims.height) & ~1;
      const w = Math.round((widthPct / 100) * dims.width) & ~1;
      const h = Math.round((heightPct / 100) * dims.height) & ~1;
      if (w <= 0 || h <= 0) {
        return reply.status(400).send({ error: 'Invalid crop dimensions' });
      }

      const chunks: Buffer[] = [];
      const args = [
        '-ss', String(time),
        '-i', sourceUrl,
        '-vf', `crop=${w}:${h}:${x}:${y}`,
        '-vframes', '1',
        '-f', 'image2',
        '-c:v', 'mjpeg',
        'pipe:1',
      ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        proc.stdout.on('data', (chunk) => chunks.push(chunk));
        proc.on('error', reject);
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with code ${code}`));
        });
      });

      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString('base64');
      return reply.send({ image: `data:image/jpeg;base64,${base64}` });
    } catch (e) {
      request.log.error(e);
      return reply.status(500).send({ error: 'Failed to generate preview' });
    }
  });
};

export default workflowsRoutes;
