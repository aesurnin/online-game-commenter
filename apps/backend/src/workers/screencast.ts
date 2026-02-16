import '../load-env.js';
import { Worker } from 'bullmq';
import puppeteer from 'puppeteer';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { uploadToR2 } from '../lib/r2.js';
import type { ScreencastJobData } from '../lib/queue.js';
import type { Page } from 'puppeteer';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}
const DISPLAY = process.env.DISPLAY || ':99';
const PULSE_SINK = process.env.PULSE_SINK || 'recording';
const VIEWPORT_WIDTH = parseInt(process.env.SCREENCAST_VIEWPORT_WIDTH || '1280', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.SCREENCAST_VIEWPORT_HEIGHT || '720', 10);

const redisOpts = parseRedisUrl(REDIS_URL);
const BACKEND_URL = process.env.BACKEND_URL || ''; // e.g. http://host.docker.internal:3000
const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';
const PREVIEW_INTERVAL_MS = 500;

async function resolveUrl(url: string): Promise<{ finalUrl: string; isHtml: boolean }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScreencastBot/1.0)' },
  });
  const finalUrl = res.url;
  const contentType = res.headers.get('content-type') || '';
  const isHtml = contentType.includes('text/html');
  return { finalUrl, isHtml };
}

const DEFAULT_PLAY_SELECTORS = [
  '#playBtn',
  'button#playBtn',
  'button[aria-label*="play" i]',
  '[data-action="play"]',
  '[data-action="start"]',
  'button.play',
  '.play-btn',
  '.play-button',
  '[class*="play"]',
  '[class*="Play"]',
  'button[title*="play" i]',
  '[role="button"][aria-label*="play" i]',
  'video + button',
  '[class*="replay"] button',
  '[class*="Replay"] button',
  '.replay-controls button',
  '[class*="playback"] button',
  'button',
];

async function tryClickPlay(
  ctx: { $(sel: string): Promise<{ click(): Promise<void>; dispose(): void } | null>; evaluate<T>(fn: () => T): Promise<T> },
  selectors: string[]
): Promise<{ clicked: boolean; selector?: string }> {
  for (const sel of selectors) {
    try {
      const el = await ctx.$(sel);
      if (el) {
        await el.click();
        el.dispose();
        return { clicked: true, selector: sel };
      }
    } catch {
      // try next
    }
  }
  try {
    const ok = await ctx.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="play"], [class*="Play"]'));
      const play = buttons.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        return (t === 'play' || label.includes('play') || title.includes('play')) && !t.includes('replay');
      });
      if (play && play instanceof HTMLElement) {
        play.click();
        return true;
      }
      return false;
    });
    return { clicked: ok, selector: ok ? '(evaluate by text/attr)' : undefined };
  } catch {
    return { clicked: false };
  }
}

async function clickPlayButton(
  page: Page,
  videoId: string,
  playSelectors: string[] | undefined,
  log: (msg: string) => void
): Promise<boolean> {
  const selectors = playSelectors?.length ? playSelectors : DEFAULT_PLAY_SELECTORS;

  log('[Play] Waiting for #playBtn or preloader to disappear...');
  for (let i = 0; i < 10; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try {
      await page.waitForSelector('#playBtn', { timeout: 2000, visible: true });
      log('[Play] Found #playBtn, waiting 1s...');
      break;
    } catch {
      if (i === 9) log('[Play] #playBtn not found in 20s, waiting for preloader...');
    }
  }
  for (let i = 0; i < 5; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try {
      await page.waitForFunction(
        () => {
          const p = document.querySelector('.preloader');
          return !p || (p as HTMLElement).offsetParent === null;
        },
        { timeout: 2000 }
      );
      log('[Play] Preloader gone');
      break;
    } catch {
      if (i === 4) log('[Play] Preloader still visible, continuing anyway');
    }
  }
  if (await isJobCancelled(videoId)) throw new JobCancelledError();
  await new Promise((r) => setTimeout(r, 1000));

  log('[Play] Trying selectors in frames...');
  for (const frame of page.frames()) {
    try {
      const result = await tryClickPlay(frame, selectors);
      if (result.clicked) {
        log(`[Play] OK: clicked via selector "${result.selector}"`);
        return true;
      }
    } catch (e) {
      log(`[Play] Frame error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  log('[Play] No selector matched in frames, trying evaluate fallback...');
  try {
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button, [role="button"], div[class*="play"], div[class*="Play"], span[class*="play"], span[class*="Play"]');
      for (const el of all) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if ((txt === 'play' || cls.includes('play') && !cls.includes('replay') || label.includes('play')) && el instanceof HTMLElement) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      log('[Play] OK: clicked via evaluate (text/attr)');
      return true;
    }
  } catch (e) {
    log(`[Play] Evaluate fallback error: ${e instanceof Error ? e.message : String(e)}`);
  }

  log('[Play] FAILED: no play button found, using center click fallback');
  try {
    await page.mouse.click(VIEWPORT_WIDTH / 2, VIEWPORT_HEIGHT / 2);
    log('[Play] Center click done (may or may not work)');
    return true;
  } catch (e) {
    log(`[Play] Center click error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

const PREVIEW_ERROR_LOG_INTERVAL_MS = 30_000; // log at most once per 30s when failing

class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled by user');
    this.name = 'JobCancelledError';
  }
}

async function isJobCancelled(videoId: string): Promise<boolean> {
  const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
  return !v || v.status === 'cancelled';
}

function startLivePreview(page: Page, videoId: string, log: (msg: string) => void): () => void {
  if (!BACKEND_URL || !PREVIEW_SECRET) {
    log('Live preview disabled (BACKEND_URL or SCREENCAST_PREVIEW_SECRET not set)');
    return () => {};
  }
  const url = `${BACKEND_URL.replace(/\/$/, '')}/internal/live-preview/${videoId}`;
  log(`Live preview sending to ${url}`);
  let lastErrorLogAt = 0;
  let firstError = true;
  const intervalId = setInterval(async () => {
    try {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Preview-Token': PREVIEW_SECRET,
        },
        body: jpeg as unknown as BodyInit,
      });
      if (!res.ok) {
        const now = Date.now();
        if (firstError || now - lastErrorLogAt >= PREVIEW_ERROR_LOG_INTERVAL_MS) {
          firstError = false;
          lastErrorLogAt = now;
          log(`Preview POST ${res.status} ${res.statusText}`);
        }
      }
    } catch (e) {
      const now = Date.now();
      if (firstError || now - lastErrorLogAt >= PREVIEW_ERROR_LOG_INTERVAL_MS) {
        firstError = false;
        lastErrorLogAt = now;
        log(`Preview send error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }, PREVIEW_INTERVAL_MS);
  return () => clearInterval(intervalId);
}

async function waitForReplayEnd(
  page: Page,
  videoId: string,
  endSelectors: string[] | undefined,
  durationLimitSeconds: number
): Promise<'done' | 'cancelled' | 'stop'> {
  const start = Date.now();
  const pollInterval = 800;

  return new Promise((resolve) => {
    const check = async () => {
      const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
      if (!v || v.status === 'cancelled') {
        resolve('cancelled');
        return;
      }
      const meta = v?.metadata as { stopRequested?: boolean } | null;
      if (meta?.stopRequested) {
        console.log(`[${videoId.slice(0, 8)}] Stop requested by user, stopping recording`);
        resolve('stop');
        return;
      }

      const elapsed = (Date.now() - start) / 1000;
      if (elapsed >= durationLimitSeconds) {
        resolve('done');
        return;
      }

      if (endSelectors?.length) {
        try {
          const found = await page.evaluate((selectors: string[]) => {
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel);
                if (el) return true;
              } catch {
                // selector invalid, skip
              }
            }
            return false;
          }, endSelectors);
          if (found) {
            resolve('done');
            return;
          }
        } catch {
          // page might be gone
        }
      }

      setTimeout(check, pollInterval);
    };
    check();
  });
}

async function runScreencastJob(jobData: ScreencastJobData): Promise<void> {
  const { projectId, videoId, url, durationLimit = 600, endSelectors, playSelectors } = jobData;
  const log = (msg: string) => console.log(`[${videoId.slice(0, 8)}] ${msg}`);
  log('Job started');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screencast-'));
  const outputPath = path.join(tmpDir, 'output.mp4');

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let ffmpegProc: ReturnType<typeof spawn> | null = null;
  let stopPreview: () => void = () => {};

  try {
    const [v0] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v0 || v0.status === 'cancelled') return;

    const { finalUrl, isHtml } = await resolveUrl(url);
    log(`URL resolved: ${finalUrl}, isHtml=${isHtml}`);
    if (!isHtml) {
      throw new Error(`URL does not serve HTML (content-type may be JSON). Cannot record: ${finalUrl}`);
    }

    browser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--ignore-gpu-blocklist',
        '--audio-output-channels=2',
        '--autoplay-policy=no-user-gesture-required',
      ],
      env: {
        ...process.env,
        DISPLAY,
        PULSE_SERVER: process.env.PULSE_SERVER || undefined,
      },
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    const page = await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    const ffmpegArgs = [
      '-y',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', '30',
      '-video_size', `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
      '-i', `${DISPLAY}.0+0,0`,
      '-f', 'pulse',
      '-i', `${PULSE_SINK}.monitor`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      outputPath,
    ];

    ffmpegProc = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DISPLAY },
    });

    let ffmpegStderr = '';
    ffmpegProc.stderr?.on('data', (d) => { ffmpegStderr += d.toString(); });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 3000);
      ffmpegProc!.on('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      ffmpegProc!.once('spawn', () => {
        clearTimeout(t);
        resolve();
      });
    });

    log('Navigating to page...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    log('Page loaded, looking for play button...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    stopPreview = startLivePreview(page, videoId, log);

    const clicked = await clickPlayButton(page, videoId, playSelectors, log);
    log(clicked ? 'Play clicked, starting recording wait' : 'Play NOT clicked (may use fallback)');
    if (clicked) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    log('Recording... (waiting for replay end or stop/cancel)');
    const result = await waitForReplayEnd(page, videoId, endSelectors, durationLimit);
    log(`Recording stopped: ${result}`);

    ffmpegProc.kill('SIGINT');
    let exitCode: number | null = null;
    await new Promise<void>((resolve) => {
      ffmpegProc!.on('close', (code) => {
        exitCode = code ?? null;
        resolve();
      });
      setTimeout(resolve, 5000);
    });
    ffmpegProc = null;

    await browser.close();
    browser = null;

    if (result === 'cancelled') return;

    // FFmpeg may need a moment to finalize the MP4 after SIGINT
    await new Promise((r) => setTimeout(r, 1000));
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    for (let i = 0; i < 6; i++) {
      try {
        stat = await fs.stat(outputPath);
        if (stat.size >= 1000) break;
      } catch {
        if (i < 5) await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!stat || stat.size < 1000) {
      const hint = exitCode !== 0 ? ` FFmpeg exit code: ${exitCode}.` : '';
      const stderr = ffmpegStderr ? ` FFmpeg stderr: ${ffmpegStderr.slice(-500)}` : '';
      throw new Error(`Output file not found or too small after recording.${hint}${stderr}`);
    }

    const buffer = await fs.readFile(outputPath);
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
    const key = `projects/${projectId}/${filename}`;
    await uploadToR2(key, buffer);

    await db.update(videoEntities)
      .set({ status: 'ready', sourceUrl: key, metadata: {} })
      .where(eq(videoEntities.id, videoId));
  } catch (err) {
    if (err instanceof JobCancelledError) return;
    const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v || v.status === 'cancelled') return;
    const message = err instanceof Error ? err.message : String(err);
    await db.update(videoEntities)
      .set({
        status: 'failed',
        metadata: { error: message },
      })
      .where(eq(videoEntities.id, videoId));
    throw err;
  } finally {
    stopPreview();
    if (ffmpegProc) ffmpegProc.kill('SIGKILL');
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const worker = new Worker<ScreencastJobData>(
  'screencast',
  async (job) => {
    console.log('[Worker] Processing job', job.id, 'videoId=', job.data?.videoId?.slice(0, 8));
    await runScreencastJob(job.data);
  },
  {
    connection: { ...redisOpts, maxRetriesPerRequest: null },
    concurrency: 1,
  }
);

worker.on('active', (job) => {
  console.log(`[Worker] Job ${job.id} active, videoId=${(job.data as ScreencastJobData).videoId?.slice(0, 8)}`);
});

worker.on('completed', (job) => {
  console.log(`Screencast job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Screencast job ${job?.id} failed:`, err);
});

worker.on('error', (err) => {
  console.error('[Worker] Redis/connection error:', err);
});

console.log('Screencast worker started. DISPLAY=%s PULSE_SINK=%s REDIS=%s:%d', DISPLAY, PULSE_SINK, redisOpts.host, redisOpts.port);
