#!/usr/bin/env npx tsx
/**
 * Recover a fal.ai Fabric video into the workflow cache.
 * Use when generation completed on fal.ai but our worker failed (e.g. "fetch failed").
 *
 * 1. Open your fal.ai result (share link or dashboard)
 * 2. Right-click the video -> "Copy video address", or use the Download button URL
 * 3. From repo root run:
 *      cd apps/backend && npx tsx scripts/recover-fal-video.ts "https://v3.fal.media/files/..."
 *
 * Optional: override project/video IDs if different from the default (from job 141):
 *   cd apps/backend && npx tsx scripts/recover-fal-video.ts "URL" [projectId] [videoId]
 */

import fs from 'fs/promises';
import path from 'path';

const DEFAULT_PROJECT_ID = '6de6885d-3926-4aff-a0a1-5c68152d3276';
const DEFAULT_VIDEO_ID = '6227f6ae-9a42-4606-b990-48cdd0a5a9f1';
const FAL_MODULE_FOLDER = 'video-fal-veed-fabric-je4qd6g';

async function main() {
  const url = process.argv[2];
  if (!url || !url.startsWith('http')) {
    console.error('Usage: (from apps/backend) npx tsx scripts/recover-fal-video.ts <video_url> [projectId] [videoId]');
    console.error('Example: npx tsx scripts/recover-fal-video.ts "https://v3.fal.media/files/..."');
    process.exit(1);
  }

  const projectId = process.argv[3] ?? DEFAULT_PROJECT_ID;
  const videoId = process.argv[4] ?? DEFAULT_VIDEO_ID;

  const base = process.env.WORKFLOW_CACHE_BASE ?? path.join(process.cwd(), 'workflow-cache');
  const cacheDir = path.join(base, projectId, videoId, FAL_MODULE_FOLDER);
  const outputPath = path.join(cacheDir, 'output.mp4');

  console.log('Downloading from:', url.slice(0, 80) + '...');
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Failed to fetch:', res.status, res.statusText);
    process.exit(1);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(outputPath, buffer);

  // metadata.json for cost tracking (duration unknown, estimate from file)
  const stat = await fs.stat(outputPath);
  const metadata = {
    provider: 'fal.ai',
    model: 'veed/fabric-1.0',
    resolution: '480p',
    durationSeconds: 0,
    costUsd: 0,
    recovered: true,
    recoveredAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(cacheDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  console.log('Saved to:', outputPath);
  console.log('Size:', (stat.size / 1024).toFixed(1), 'KB');
  console.log('Refresh the workflow panel — step 7 should show as done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
