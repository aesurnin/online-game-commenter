import { Queue } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379', 10),
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const redisOpts = parseRedisUrl(REDIS_URL);

export type ScreencastJobData = {
  projectId: string;
  videoId: string;
  url: string;
  durationLimit?: number;
  endSelectors?: string[];
  playSelectors?: string[];
};

export const screencastQueue = new Queue<ScreencastJobData>('screencast', {
  connection: { ...redisOpts, maxRetriesPerRequest: null },
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});

export async function addScreencastJob(data: ScreencastJobData) {
  const job = await screencastQueue.add('record', data);
  console.log('[Queue] Added screencast job', job.id, 'videoId=', data.videoId?.slice(0, 8));
  return job;
}
