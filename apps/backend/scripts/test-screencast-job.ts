#!/usr/bin/env node
/**
 * Add a test screencast job directly to the queue (bypasses the main app).
 * Run from project root: cd apps/backend && npx tsx scripts/test-screencast-job.ts
 * Or: npm run test:screencast (from apps/backend)
 *
 * Requires: Docker (postgres, redis, screencast-worker) and backend .env
 */
import '../src/load-env.js';
import { db } from '../src/db/index.js';
import { users, projects, videoEntities } from '../src/db/schema/index.js';
import { addScreencastJob } from '../src/lib/queue.js';
import { eq } from 'drizzle-orm';

const TEST_URL = process.argv[2] || 'https://bgaming-network.com/api/replays/53143950828';

async function main() {
  console.log('Test screencast job');
  console.log('URL:', TEST_URL);
  console.log('');

  const [user] = await db.select().from(users).limit(1);
  if (!user) {
    console.error('No users in DB. Create an account via the app first (e.g. /register).');
    process.exit(1);
  }
  console.log('Using user:', user.email || user.id);

  const [project] = await db.select().from(projects).where(eq(projects.ownerId, user.id)).limit(1);
  if (!project) {
    console.error('No projects. Create a project via the app first.');
    process.exit(1);
  }
  console.log('Using project:', project.name, project.id);

  const [video] = await db
    .insert(videoEntities)
    .values({
      projectId: project.id,
      status: 'processing',
      sourceUrl: TEST_URL,
    })
    .returning();

  if (!video) {
    console.error('Failed to create video record');
    process.exit(1);
  }
  console.log('Created video:', video.id);

  await addScreencastJob({
    projectId: project.id,
    videoId: video.id,
    url: TEST_URL,
    durationLimit: 120,
    playSelectors: ['#playBtn', 'button#playBtn', '[class*="replay"] button'],
  });

  console.log('');
  console.log('Job added. Worker should pick it up within seconds.');
  console.log('Watch worker logs: docker logs -f online-game-commenter-screencast-worker-1');
  console.log('View in app: open project', project.name, 'and select the new video');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
