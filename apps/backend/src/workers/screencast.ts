import '../load-env.js';
import { Worker } from 'bullmq';
import puppeteer from 'puppeteer';
import { launch as launchStream, getStream } from 'puppeteer-stream';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { ScreencastJobData } from '../lib/queue.js';
import { screencastQueue } from '../lib/queue.js';
import type { Page } from 'puppeteer';

async function cleanupStuckActiveJobs(): Promise<void> {
  const active = await screencastQueue.getActive();
  if (active.length === 0) return;
  console.log(`[Worker] Cleaning up ${active.length} stuck active job(s) from previous run...`);
  const client = await screencastQueue.client;
  for (const job of active) {
    try {
      const lockKey = `${screencastQueue.toKey(job.id!)}:lock`;
      const token = await client.get(lockKey);
      if (token) {
        await job.moveToFailed(new Error('Worker restarted'), token);
        console.log(`[Worker] Moved job ${job.id} to failed (worker restarted)`);
      } else {
        await job.remove();
        console.log(`[Worker] Removed orphaned job ${job.id} (lock expired)`);
      }
      const videoId = (job.data as ScreencastJobData)?.videoId;
      if (videoId) {
        await db.update(videoEntities)
          .set({ status: 'failed', metadata: { error: 'Worker restarted' } })
          .where(eq(videoEntities.id, videoId));
      }
    } catch (e) {
      console.error(`[Worker] Failed to cleanup job ${job.id}:`, e);
    }
  }
}

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
const VIEWPORT_WIDTH = parseInt(process.env.SCREENCAST_VIEWPORT_WIDTH || '1920', 10);
const VIEWPORT_HEIGHT = parseInt(process.env.SCREENCAST_VIEWPORT_HEIGHT || '1200', 10);

const redisOpts = parseRedisUrl(REDIS_URL);
const BACKEND_URL = process.env.BACKEND_URL || ''; // e.g. http://host.docker.internal:3000
const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';
const PREVIEW_INTERVAL_MS = 500;
const RECORDING_STRATEGY = process.env.RECORDING_STRATEGY || 'docker';

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
  '.play-icon',
  '.play-button',
  '.play-btn',
  'button.play',
  '[class*="play"]',
  '[class*="Play"]',
  '[class*="replay"]',
  '[class*="Replay"]',
  'svg[class*="play"]',
  'button[aria-label*="play" i]',
  'button[aria-label*="replay" i]',
  '[data-action="play"]',
  '[data-action="start"]',
  '[data-action="replay"]',
  'button[title*="play" i]',
  '[role="button"][aria-label*="play" i]',
  'video + button',
  'button',
];

async function tryClickPlay(
  ctx: { $(sel: string): Promise<{ click(): Promise<void>; dispose(): void } | null>; evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> },
  selectors: string[],
  log: (msg: string) => void
): Promise<{ clicked: boolean; selector?: string }> {
  for (const sel of selectors) {
    try {
      const el = await ctx.$(sel);
      if (el) {
        try {
          await ctx.evaluate((selector) => {
            const e = document.querySelector(selector);
            if (e instanceof HTMLElement) e.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, sel);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          // ignore
        }
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
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[class*="play"], div[class*="Play"], div[class*="replay"], span[class*="play"], span[class*="replay"], svg, a'));
      
      // 1. Try exact text matches or common play-related text/symbols
      for (const b of buttons) {
        if (!(b instanceof HTMLElement)) continue;
        const txt = (b.textContent || '').trim();
        const lowTxt = txt.toLowerCase();
        if ((lowTxt === 'play' || lowTxt === 'replay' || lowTxt === 'start' || txt === '⏵' || txt === '\u23F5' || lowTxt === 'x1') && b.offsetParent !== null) {
          b.click();
          return true;
        }
      }

      // 2. Try triangle icon in SVG more aggressively
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const html = svg.innerHTML.toLowerCase();
        const box = svg.getBoundingClientRect();
        // Play triangle usually has a path with many points or specific keywords
        if (box.width > 5 && (html.includes('play') || html.includes('polygon') || html.includes('path'))) {
          // Click the SVG itself or its clickable parent
          let curr: HTMLElement | null = svg as unknown as HTMLElement;
          for (let i = 0; i < 4; i++) {
            if (curr && (curr.tagName === 'BUTTON' || curr.getAttribute('role') === 'button' || curr.className.toLowerCase().includes('play'))) {
              curr.click();
              return true;
            }
            curr = curr?.parentElement || null;
          }
          (svg as unknown as HTMLElement).click();
          return true;
        }
      }

      // 3. Try broader attribute matches
      for (const b of buttons) {
        if (!(b instanceof HTMLElement)) continue;
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        const cls = (b.className || '').toLowerCase();
        const t = (b.textContent || '').toLowerCase();
        
        if ((label.includes('play') || label.includes('replay') || title.includes('play') || cls.includes('play-btn') || cls.includes('replay-btn')) &&
            !t.includes('x2') && !t.includes('x4')) {
          b.click();
          return true;
        }
      }
      return false;
    });
    return { clicked: ok, selector: ok ? '(evaluate by text/icon/attr)' : undefined };
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
  log('[Play] Single precise click on #playBtn...');
  
  for (let i = 0; i < 20; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    
    for (const frame of page.frames()) {
      try {
        const btn = await frame.$('#playBtn');
        if (btn) {
          const isVisible = await frame.evaluate((b) => {
            const style = window.getComputedStyle(b);
            return b instanceof HTMLElement && b.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
          }, btn);

          if (isVisible) {
            log(`[Play] Found visible #playBtn in frame ${frame.name() || 'main'}. Clicking ONCE.`);
            
            // Just one click method. Puppeteer's high-level click is usually best 
            // as it handles visibility and scrolling.
            await btn.click();
            
            log('[Play] Click performed. Waiting to verify...');
            await new Promise(r => setTimeout(r, 2000));
            return true; 
          }
        }
      } catch { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  log('[Play] FAILED: Could not find or click #playBtn');
  return false;
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
  const pollInterval = 250;

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

async function runStreamScreencast(jobData: ScreencastJobData, log: (msg: string) => void, outputPath: string, tmpDir: string): Promise<string | undefined> {
  const { projectId, videoId, url, durationLimit = 600, endSelectors, playSelectors } = jobData;
  let browser: any = null;
  let ffmpegProc: ReturnType<typeof spawn> | null = null;
  let stopPreview: () => void = () => {};

  try {
    const { finalUrl, isHtml } = await resolveUrl(url);
    log(`[Stream] URL resolved: ${finalUrl}, isHtml=${isHtml}`);
    if (!isHtml) {
      throw new Error(`URL does not serve HTML (content-type may be JSON). Cannot record: ${finalUrl}`);
    }

    browser = await launchStream({
      executablePath: puppeteer.executablePath(),
      headless: 'new',
      startDelay: 500,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--autoplay-policy=no-user-gesture-required',
        '--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      ],
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    log('[Stream] Navigating to page...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    await page.addStyleTag({
      content: `
        body, html {
          margin: 0 !important;
          padding: 0 !important;
        }
        /* Hide scrollbars for cleaner recording */
        ::-webkit-scrollbar { display: none !important; }
        * { -ms-overflow-style: none !important; scrollbar-width: none !important; }
      `
    });

    log('[Stream] Starting live preview...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    stopPreview = startLivePreview(page, videoId, log);

    log('[Stream] Looking for play button (before recording)...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    const clicked = await clickPlayButton(page, videoId, playSelectors, log);
    log(clicked ? '[Stream] Play clicked, waiting for game to stabilize...' : '[Stream] Play NOT clicked (may use fallback)');
    await new Promise((r) => setTimeout(r, 3000));

    log('[Stream] Starting capture stream...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    const stream = await getStream(page, { audio: true, video: true });

    const ffmpegArgs = [
      '-y',
      '-f', 'webm',
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath,
    ];

    ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    stream.pipe(ffmpegProc.stdin!);

    let ffmpegStderr = '';
    ffmpegProc.stderr?.on('data', (d) => { ffmpegStderr += d.toString(); });

    log('[Stream] Recording... (waiting for replay end or stop/cancel)');
    const result = await waitForReplayEnd(page, videoId, endSelectors, durationLimit);
    log(`[Stream] Recording stopped: ${result}`);

    // Cleanup stream and ffmpeg
    stream.destroy();
    ffmpegProc.stdin?.end();
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

    if (result === 'cancelled') return 'cancelled';

    return 'done';
  } catch (err) {
    if (ffmpegProc) {
      ffmpegProc.kill('SIGKILL');
    }
    if (browser) await browser.close().catch(() => {});
    throw err;
  } finally {
    stopPreview();
  }
}

async function runDockerScreencast(
  jobData: ScreencastJobData,
  log: (msg: string) => void,
  outputPath: string
): Promise<string | undefined> {
  const { videoId, url, durationLimit = 600, endSelectors, playSelectors } = jobData;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  let ffmpegProc: ReturnType<typeof spawn> | null = null;
  let stopPreview: () => void = () => {};

  try {
    const { finalUrl, isHtml } = await resolveUrl(url);
    log(`[Docker] URL resolved: ${finalUrl}, isHtml=${isHtml}`);
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
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--start-fullscreen',
        '--kiosk',
        `--app=${finalUrl}`,
        '--window-position=0,0',
        `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      ],
      env: {
        ...process.env,
        DISPLAY,
        PULSE_SERVER: process.env.PULSE_SERVER || undefined,
      },
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    const ffmpegArgs = [
      '-y',
      '-thread_queue_size', '1024',
      '-f', 'x11grab',
      '-draw_mouse', '0',
      '-framerate', '30',
      '-video_size', `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
      '-i', `${DISPLAY}.0+0,0`,
      '-thread_queue_size', '1024',
      '-f', 'pulse',
      '-ac', '2',
      '-ar', '44100',
      '-i', `${PULSE_SINK}.monitor`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
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

    log('[Docker] Navigating to page...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    log('[Docker] Navigating to page...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    await page.addStyleTag({
      content: `
        body, html {
          margin: 0 !important;
          padding: 0 !important;
        }
        /* Hide scrollbars for cleaner recording */
        ::-webkit-scrollbar { display: none !important; }
        * { -ms-overflow-style: none !important; scrollbar-width: none !important; }
      `
    });

    log('[Docker] Page loaded, looking for play button...');
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    stopPreview = startLivePreview(page, videoId, log);

    const clicked = await clickPlayButton(page, videoId, playSelectors, log);
    log(clicked ? '[Docker] Play clicked, starting recording wait' : '[Docker] Play NOT clicked (may use fallback)');
    if (clicked) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    log('[Docker] Recording... (waiting for replay end or stop/cancel)');
    const result = await waitForReplayEnd(page, videoId, endSelectors, durationLimit);
    log(`[Docker] Recording stopped: ${result}`);

    ffmpegProc.kill('SIGINT');
    let exitCode: number | null = null;
    await new Promise<void>((resolve) => {
      ffmpegProc!.on('close', (code) => {
        exitCode = code ?? null;
        resolve();
      });
      setTimeout(resolve, 5000);
    });
    
    if (exitCode !== 0 && exitCode !== null) {
      log(`[Docker] FFmpeg non-zero exit: ${exitCode}. Stderr: ${ffmpegStderr.slice(-200)}`);
    }
    ffmpegProc = null;

    await browser.close();
    browser = null;

    return result;
  } catch (err) {
    if (ffmpegProc) ffmpegProc.kill('SIGKILL');
    if (browser) await browser.close().catch(() => {});
    throw err;
  } finally {
    stopPreview();
  }
}

async function runScreencastJob(jobData: ScreencastJobData): Promise<void> {
  const { projectId, videoId, url } = jobData;
  const log = (msg: string) => console.log(`[${videoId.slice(0, 8)}] ${msg}`);
  log(`Job started, strategy=${RECORDING_STRATEGY}`);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screencast-'));
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    const [v0] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v0 || v0.status === 'cancelled') return;

    let result: string | undefined;
    if (RECORDING_STRATEGY === 'puppeteer-stream') {
      result = await runStreamScreencast(jobData, log, outputPath, tmpDir);
    } else {
      result = await runDockerScreencast(jobData, log, outputPath);
    }

    if (result === 'cancelled') return;

    // Common upload logic
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
      throw new Error(`Output file not found or too small after recording (${stat?.size || 0} bytes).`);
    }

    const buffer = await fs.readFile(outputPath);
    if (!BACKEND_URL || !PREVIEW_SECRET) {
      throw new Error('BACKEND_URL and SCREENCAST_PREVIEW_SECRET required for video upload');
    }
    const uploadUrl = `${BACKEND_URL.replace(/\/$/, '')}/internal/upload-video/${videoId}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'video/mp4',
        'X-Preview-Token': PREVIEW_SECRET,
        'X-Project-Id': projectId,
      },
      body: buffer as unknown as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Upload failed: ${res.status} ${res.statusText} - ${text}`);
    }
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
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}


async function startWorker(): Promise<void> {
  await cleanupStuckActiveJobs();

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

  console.log(
  'Screencast worker started. strategy=%s DISPLAY=%s PULSE_SINK=%s REDIS=%s:%d BACKEND_URL=%s preview=%s',
  RECORDING_STRATEGY,
  DISPLAY,
  PULSE_SINK,
  redisOpts.host,
  redisOpts.port,
  BACKEND_URL || '(not set)',
  PREVIEW_SECRET ? 'enabled' : 'disabled'
  );
}

startWorker().catch((err) => {
  console.error('[Worker] Startup failed:', err);
  process.exit(1);
});
