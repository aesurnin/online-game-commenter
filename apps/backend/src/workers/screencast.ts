import '../load-env.js';
import { Worker } from 'bullmq';
import { launch, getStream } from 'puppeteer-stream';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { db } from '../db/index.js';
import { videoEntities } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { ScreencastJobData } from '../lib/queue.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function parseRedisUrl(url: string): { host: string; port: number } {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: parseInt(u.port || '6379', 10) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const redisOpts = parseRedisUrl(REDIS_URL);
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const PREVIEW_SECRET = process.env.SCREENCAST_PREVIEW_SECRET || '';
const PREVIEW_INTERVAL_MS = 500;
const DEFAULT_VIEWPORT_WIDTH = 1920;
const DEFAULT_VIEWPORT_HEIGHT = 1080;
const MIN_VIEWPORT_WIDTH = 640;
const MIN_VIEWPORT_HEIGHT = 360;
const MAX_VIEWPORT_WIDTH = 1920;
const MAX_VIEWPORT_HEIGHT = 1080;

// Window position off-screen so it does not steal focus or expand to fullscreen (headed mode required for proper rendering)
const WINDOW_POSITION = process.env.SCREENCAST_WINDOW_POSITION || '9999,9999';

async function resolveUrl(url: string): Promise<{ finalUrl: string; isHtml: boolean }> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ScreencastBot/1.0)' },
  });
  return { finalUrl: res.url, isHtml: (res.headers.get('content-type') || '').includes('text/html') };
}

const DEFAULT_PLAY_SELECTORS = [
  '#playBtn', 'button#playBtn', 'button[aria-label*="play" i]', '[data-action="play"]', '[data-action="start"]',
  'button.play', '.play-btn', '.play-button', '[class*="play"]', '[class*="Play"]', 'button[title*="play" i]',
  '[role="button"][aria-label*="play" i]', 'video + button', '[class*="replay"] button', '[class*="Replay"] button',
  '.replay-controls button', '[class*="playback"] button', 'button',
];

class JobCancelledError extends Error {
  constructor() { super('Job cancelled by user'); this.name = 'JobCancelledError'; }
}

async function isJobCancelled(videoId: string): Promise<boolean> {
  const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
  return !v || v.status === 'cancelled';
}

async function detectContentSize(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<{ width: number; height: number }> {
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (canvas && (canvas as HTMLCanvasElement).width > 0 && (canvas as HTMLCanvasElement).height > 0) {
      return { width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height };
    }
    for (const sel of ['.game-container', '[class*="replay"]', '[class*="Replay"]', '#game', '.game']) {
      const el = document.querySelector(sel);
      if (el && el instanceof HTMLElement) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return { width: Math.round(rect.width), height: Math.round(rect.height) };
      }
    }
    const w = Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, window.innerWidth);
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, window.innerHeight);
    return { width: w || 1280, height: h || 720 };
  }) as { width: number; height: number };
  
  let { width, height } = result;
  
  // Ensure dimensions are even (required by some encoders)
  width = width % 2 === 0 ? width : width + 1;
  height = height % 2 === 0 ? height : height + 1;

  return {
    width: Math.max(MIN_VIEWPORT_WIDTH, Math.min(MAX_VIEWPORT_WIDTH, width)),
    height: Math.max(MIN_VIEWPORT_HEIGHT, Math.min(MAX_VIEWPORT_HEIGHT, height)),
  };
}

async function injectFitCSS(page: { evaluate: (fn: () => void) => Promise<void> }): Promise<void> {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = `
      * { 
        margin: 0 !important; 
        padding: 0 !important; 
        overflow: hidden !important; 
      }
      html, body { 
        background: black !important;
        width: 100vw !important;
        height: 100vh !important;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
      } 
      canvas, video, iframe, .game-container, [class*="game"], [class*="replay"], [class*="Replay"] { 
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        width: 100vw !important; 
        height: 100vh !important; 
        max-width: none !important;
        max-height: none !important;
        object-fit: fill !important; 
        z-index: 999999 !important;
      }
    `;
    document.head.appendChild(style);
    
    // Prevent any scrolling attempts
    window.scrollTo(0, 0);
    window.addEventListener('scroll', (e) => {
      window.scrollTo(0, 0);
      e.preventDefault();
    }, { passive: false });
  });
}

async function tryClickPlay(ctx: { $: (s: string) => Promise<{ click: () => Promise<void>; dispose: () => void } | null>; evaluate: (fn: () => boolean) => Promise<boolean> }, selectors: string[]): Promise<{ clicked: boolean; selector?: string }> {
  for (const sel of selectors) {
    try {
      const el = await ctx.$(sel);
      if (el) { await el.click(); el.dispose(); return { clicked: true, selector: sel }; }
    } catch { /* next */ }
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
      if (play && play instanceof HTMLElement) { play.click(); return true; }
      return false;
    });
    return { clicked: ok, selector: ok ? '(evaluate)' : undefined };
  } catch { return { clicked: false }; }
}

async function clickPlayButton(
  page: { frames: () => { $: (s: string) => Promise<unknown>; evaluate: (fn: () => boolean) => Promise<boolean> }[]; waitForSelector: (s: string, o: { timeout: number; visible: boolean }) => Promise<unknown>; waitForFunction: (fn: () => boolean, o: { timeout: number }) => Promise<unknown>; evaluate: (fn: () => boolean) => Promise<boolean>; mouse: { click: (x: number, y: number) => Promise<void> } },
  videoId: string, playSelectors: string[] | undefined, viewportWidth: number, viewportHeight: number, log: (m: string) => void
): Promise<boolean> {
  const selectors = playSelectors?.length ? playSelectors : DEFAULT_PLAY_SELECTORS;
  log('[Play] Waiting for #playBtn or preloader...');
  for (let i = 0; i < 10; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try { await page.waitForSelector('#playBtn', { timeout: 2000, visible: true }); log('[Play] Found #playBtn'); break; }
    catch { if (i === 9) log('[Play] #playBtn not found'); }
  }
  for (let i = 0; i < 5; i++) {
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    try { await page.waitForFunction(() => { const p = document.querySelector('.preloader'); return !p || (p as HTMLElement).offsetParent === null; }, { timeout: 2000 }); break; }
    catch { /* continue */ }
  }
  if (await isJobCancelled(videoId)) throw new JobCancelledError();
  await new Promise((r) => setTimeout(r, 1000));
  for (const frame of page.frames()) {
    try {
      const r = await tryClickPlay(frame as Parameters<typeof tryClickPlay>[0], selectors);
      if (r.clicked) { log(`[Play] OK: ${r.selector}`); return true; }
    } catch (e) { log(`[Play] Frame: ${e}`); }
  }
  try {
    const clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('button, [role="button"], div[class*="play"], span[class*="play"]');
      for (const el of all) {
        const txt = (el.textContent || '').trim().toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if ((txt === 'play' || (cls.includes('play') && !cls.includes('replay')) || label.includes('play')) && el instanceof HTMLElement) {
          el.click(); return true;
        }
      }
      return false;
    });
    if (clicked) return true;
  } catch { /* fallback */ }
  try { await page.mouse.click(viewportWidth / 2, viewportHeight / 2); return true; } catch { return false; }
}

function startLivePreview(page: { screenshot: (o: { type: string; quality: number }) => Promise<Buffer> }, videoId: string, log: (m: string) => void): () => void {
  if (!BACKEND_URL || !PREVIEW_SECRET) { log('Live preview disabled'); return () => {}; }
  const url = `${BACKEND_URL.replace(/\/$/, '')}/internal/live-preview/${videoId}`;
  let lastErr = 0;
  const id = setInterval(async () => {
    try {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 80 });
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Preview-Token': PREVIEW_SECRET }, body: Buffer.from(jpeg) });
      if (!res.ok && Date.now() - lastErr > 30000) { lastErr = Date.now(); log(`Preview ${res.status}`); }
    } catch (e) { if (Date.now() - lastErr > 30000) { lastErr = Date.now(); log(`Preview: ${e}`); } }
  }, PREVIEW_INTERVAL_MS);
  return () => clearInterval(id);
}

async function waitForReplayEnd(
  page: { evaluate: (fn: (s: string[]) => boolean, s: string[]) => Promise<boolean> },
  videoId: string, endSelectors: string[] | undefined, durationLimitSeconds: number
): Promise<'cancelled' | 'stop' | 'done'> {
  const start = Date.now();
  const poll = 300;
  return new Promise((resolve) => {
    const check = async () => {
      const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
      if (!v || v.status === 'cancelled') { resolve('cancelled'); return; }
      const meta = v?.metadata as { stopRequested?: boolean } | null;
      if (meta?.stopRequested) { resolve('stop'); return; }
      if ((Date.now() - start) / 1000 >= durationLimitSeconds) { resolve('done'); return; }
      if (endSelectors?.length) {
        try {
          const found = await page.evaluate((s: string[]) => s.some((sel) => !!document.querySelector(sel)), endSelectors);
          if (found) { resolve('done'); return; }
        } catch { /* page gone */ }
      }
      setTimeout(check, poll);
    };
    check();
  });
}

async function convertWebmToMp4(webmPath: string, mp4Path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-y', '-i', webmPath, '-c', 'copy', mp4Path], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
    setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 120_000);
  });
}

async function runScreencastJob(jobData: ScreencastJobData): Promise<void> {
  const { projectId, videoId, url, durationLimit = 600, endSelectors, playSelectors } = jobData;
  const log = (m: string) => console.log(`[${videoId.slice(0, 8)}] ${m}`);
  log('Job started');
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screencast-'));
  const webmPath = path.join(tmpDir, 'output.webm');
  const mp4Path = path.join(tmpDir, 'output.mp4');
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  let stopPreview = () => {};
  try {
    const [v0] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v0 || v0.status === 'cancelled') return;
    const { finalUrl, isHtml } = await resolveUrl(url);
    log(`URL: ${finalUrl}`);
    if (!isHtml) throw new Error(`URL does not serve HTML: ${finalUrl}`);
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    // headless: 'new' = no visible window (macOS ignores --window-position). Set SCREENCAST_HEADLESS=false for visible window.
    const useHeadless = process.env.SCREENCAST_HEADLESS !== 'false';
    const vw = 1920;
    const vh = 1080;
    
    log(`Launch config: headless=${useHeadless}, BACKEND_URL=${BACKEND_URL}, res=${vw}x${vh}@2x`);

    browser = await launch({
      headless: useHeadless,
      executablePath,
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: { width: vw, height: vh, deviceScaleFactor: 2 },
      startDelay: 1000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
        '--allowlisted-extension-id=jjndjgheafjngoipoacpjgeicjeomjli',
        `--window-size=${vw},${vh}`,
        '--force-device-scale-factor=2',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-notifications',
        '--disable-features=IsolateOrigins,site-per-process',
        '--auto-accept-this-tab-capture',
        '--kiosk', // Ultimate "no-UI" mode
        ...(useHeadless
          ? ['--headless', '--enable-audio-service', '--mute-audio=false']
          : [
              `--window-position=${WINDOW_POSITION}`,
              '--disable-background-timer-throttling',
              '--disable-backgrounding-occluded-windows',
              '--disable-renderer-backgrounding',
            ]),
      ],
    });
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    const page = await browser.newPage();
    // We already set defaultViewport in launch, no need to call it twice and cause jumps
    
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.bringToFront();
    
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    await injectFitCSS(page);
    
    // Crucial: Wait 5 seconds for the layout and capture extension to stabilize
    await new Promise((r) => setTimeout(r, 5000));
    
    stopPreview = startLivePreview(page, videoId, log);
    if (await isJobCancelled(videoId)) throw new JobCancelledError();
    
    const stream = await getStream(page, { 
      audio: true, 
      video: true, 
      videoBitsPerSecond: 8_000_000, 
      audioBitsPerSecond: 128_000,
      // Remove videoConstraints to let the browser use native tab resolution.
      // Forcing resolution here with DPR=2 often causes cropping/offset issues.
    });
    const file = createWriteStream(webmPath);
    stream.pipe(file);
    
    await clickPlayButton(page, videoId, playSelectors, vw, vh, log);
    await new Promise((r) => setTimeout(r, 1000));
    log('Recording...');
    const result = await waitForReplayEnd(page, videoId, endSelectors, durationLimit);
    log(`Stopped: ${result}`);
    stream.destroy();
    await new Promise<void>((res) => { file.on('finish', () => res()); file.on('error', () => res()); setTimeout(() => res(), 3000); });
    file.close();
    if (browser) { await browser.close(); browser = null; }
    if (result === 'cancelled') return;
    await new Promise((r) => setTimeout(r, 1000));
    let finalPath = webmPath;
    let contentType = 'video/webm';
    if (await convertWebmToMp4(webmPath, mp4Path)) {
      try {
        const stat = await fs.stat(mp4Path);
        if (stat.size >= 1000) { finalPath = mp4Path; contentType = 'video/mp4'; }
      } catch { /* keep webm */ }
    }
    const buffer = await fs.readFile(finalPath);
    if (!BACKEND_URL || !PREVIEW_SECRET) throw new Error('BACKEND_URL and SCREENCAST_PREVIEW_SECRET required');
    const res = await fetch(`${BACKEND_URL.replace(/\/$/, '')}/internal/upload-video/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'X-Preview-Token': PREVIEW_SECRET, 'X-Project-Id': projectId },
      body: buffer,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  } catch (err) {
    if (err instanceof JobCancelledError) return;
    const [v] = await db.select().from(videoEntities).where(eq(videoEntities.id, videoId));
    if (!v || v.status === 'cancelled') return;
    await db.update(videoEntities).set({ status: 'failed', metadata: { error: String(err) } }).where(eq(videoEntities.id, videoId));
    throw err;
  } finally {
    stopPreview();
    if (browser) await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const worker = new Worker<ScreencastJobData>('screencast', async (job) => {
  console.log('[Worker] Job', job.id, 'videoId=', job.data?.videoId?.slice(0, 8));
  await runScreencastJob(job.data);
}, { connection: { ...redisOpts, maxRetriesPerRequest: null }, concurrency: 1 });

worker.on('active', (j) => console.log('[Worker] Active', j.id));
worker.on('completed', (j) => console.log('[Worker] Completed', j.id));
worker.on('failed', (j, e) => console.error('[Worker] Failed', j?.id, e));
worker.on('error', (e) => console.error('[Worker] Error', e));
console.log('Screencast worker started. REDIS=%s:%d', redisOpts.host, redisOpts.port);
