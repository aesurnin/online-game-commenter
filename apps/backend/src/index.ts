import './load-env.js';
import { db } from './db/index.js';
import { providerTemplates } from './db/schema/index.js';
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { lucia } from './lib/auth.js';
import { isR2Configured } from './lib/r2.js';

if (!isR2Configured()) {
  console.error('Fatal: R2 storage is required. Set R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in .env');
  process.exit(1);
}

const server: FastifyInstance = Fastify({
  logger: true
});

server.register(cors, { 
  origin: true // In production, restrict this!
});

server.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

// Middleware to populate session
server.addHook('preHandler', async (request, reply) => {
  const sessionId = lucia.readSessionCookie(request.headers.cookie ?? "");
  if (!sessionId) {
    request.user = null;
    request.session = null;
    return;
  }

  const { session, user } = await lucia.validateSession(sessionId);
  if (session && session.fresh) {
    const sessionCookie = lucia.createSessionCookie(session.id);
    reply.header('Set-Cookie', sessionCookie.serialize());
  }
  if (!session) {
    const sessionCookie = lucia.createBlankSessionCookie();
    reply.header('Set-Cookie', sessionCookie.serialize());
  }
  request.user = user;
  request.session = session;
});

// Routes
import authRoutes from './routes/auth.js';
import projectsRoutes from './routes/projects.js';
import providersRoutes from './routes/providers.js';
import queueRoutes from './routes/queue.js';
import { internalRoutes } from './routes/internal.js';
server.register(authRoutes, { prefix: '/auth' });
server.register(projectsRoutes, { prefix: '/projects' });
server.register(providersRoutes, { prefix: '/providers' });
server.register(queueRoutes, { prefix: '/queue' });
server.register(internalRoutes, { prefix: '/internal' });

server.get('/ping', async (request, reply) => {
  return { pong: 'it works!' };
});

server.get('/config', async (request, reply) => {
  const durationLimit = parseInt(process.env.SCREENCAST_MAX_DURATION || '600', 10);
  return { durationLimit };
});

async function seedProviderTemplates() {
  const existing = await db.select().from(providerTemplates);
  if (existing.length > 0) return;
  await db.insert(providerTemplates).values({
    name: 'BGaming',
    urlPattern: 'bgaming-network.com',
    playSelectors: ['#playBtn', 'button#playBtn', '[class*="replay"]'],
    endSelectors: [],
    idleValueSelector: '[class*="total-win"], [class*="totalWin"], [class*="win-total"], [class*="winTotal"], [class*="total_win"]',
    idleSeconds: 40,
    consoleEndPatterns: [],
  });
  console.log('[Seed] Added BGaming provider template');
}

const start = async () => {
  try {
    await seedProviderTemplates();
    await server.listen({ port: 3000, host: '0.0.0.0' });
    console.log(`Server listening on ${server.server.address()}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};
start();

declare module 'fastify' {
  interface FastifyRequest {
    user: any;
    session: any;
  }
}
