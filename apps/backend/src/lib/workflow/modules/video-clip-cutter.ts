import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

/**
 * Parse a time string like "02:15", "1:02:15", "02:15.5" into total seconds.
 * Supports MM:SS, H:MM:SS, and optional fractional seconds.
 */
function parseTimeToSeconds(raw: string): number {
  const trimmed = raw.trim();

  // Try HH:MM:SS or MM:SS (with optional fractional part)
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const seconds = parseFloat(parts[1]);
    if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return minutes * 60 + seconds;
    }
  }
  if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseFloat(parts[2]);
    if (Number.isFinite(hours) && Number.isFinite(minutes) && Number.isFinite(seconds)) {
      return hours * 3600 + minutes * 60 + seconds;
    }
  }

  // Fallback: try parsing as raw number of seconds
  const num = parseFloat(trimmed);
  if (Number.isFinite(num)) return num;

  return NaN;
}

/**
 * Extract the first JSON object from a text/markdown file content.
 * Searches for the outermost { ... } block and parses it.
 */
function extractJson(text: string): Record<string, unknown> | null {
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (typeof parsed === 'object' && parsed !== null) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Not valid JSON, keep searching
          start = -1;
        }
      }
    }
  }

  return null;
}

function parseDuration(s: string): number {
  const m = s.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

function parseTime(s: string): number {
  const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

/** Format seconds back to HH:MM:SS.mmm for ffmpeg -ss / -to args */
function formatTimestamp(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export const videoClipCutterMeta = {
  type: 'video.clip.cut',
  label: 'Cut Video Clip',
  description: 'Read clip timing from a text/markdown file (JSON with clip.start_time / clip.end_time) and cut the corresponding segment from a video',
  category: 'Video',
  quickParams: [],
  inputSlots: [
    { key: 'video', label: 'Video', kind: 'video' as const },
    { key: 'text', label: 'Timing file (.txt/.md with JSON)', kind: 'text' as const },
  ],
  outputSlots: [
    { key: 'video', label: 'Clipped Video', kind: 'video' as const },
  ],
  paramsSchema: [],
};

export class VideoClipCutterModule implements WorkflowModule {
  readonly meta = videoClipCutterMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    const inputPaths = context.inputPaths ?? {};

    onLog?.('[ClipCutter] === Module start ===');

    // ── 1. Resolve input paths ──────────────────────────────────────────
    const videoPath = inputPaths['video'] || context.currentVideoPath;
    const textPath = inputPaths['text'] || context.currentTextOutputPath;

    onLog?.(`[ClipCutter] Video input path: "${videoPath}"`);
    onLog?.(`[ClipCutter] Text input path:  "${textPath}"`);

    if (!videoPath) {
      onLog?.('[ClipCutter] ERROR: No video input provided');
      return { success: false, error: 'No video input provided. Connect a video source.' };
    }
    if (!textPath) {
      onLog?.('[ClipCutter] ERROR: No text/timing file input provided');
      return { success: false, error: 'No text/timing file provided. Connect a text source with JSON clip data.' };
    }

    // ── 2. Verify files exist ───────────────────────────────────────────
    try {
      await fs.access(videoPath);
      onLog?.('[ClipCutter] Video file exists');
    } catch {
      onLog?.(`[ClipCutter] ERROR: Video file not found: ${videoPath}`);
      return { success: false, error: `Video file not found: ${videoPath}` };
    }

    try {
      await fs.access(textPath);
      onLog?.('[ClipCutter] Text file exists');
    } catch {
      onLog?.(`[ClipCutter] ERROR: Text file not found: ${textPath}`);
      return { success: false, error: `Text file not found: ${textPath}` };
    }

    onProgress?.(5, 'Reading timing file');

    // ── 3. Read and parse text file ─────────────────────────────────────
    let fileContent: string;
    try {
      fileContent = await fs.readFile(textPath, 'utf8');
      onLog?.(`[ClipCutter] Text file read successfully (${fileContent.length} chars)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onLog?.(`[ClipCutter] ERROR: Failed to read text file: ${msg}`);
      return { success: false, error: `Failed to read timing file: ${msg}` };
    }

    if (fileContent.trim().length === 0) {
      onLog?.('[ClipCutter] ERROR: Text file is empty');
      return { success: false, error: 'Timing file is empty — no JSON data found.' };
    }

    onLog?.(`[ClipCutter] Text file preview (first 500 chars): ${fileContent.slice(0, 500)}`);

    // ── 4. Extract JSON from text ───────────────────────────────────────
    onProgress?.(10, 'Parsing JSON');

    const json = extractJson(fileContent);
    if (!json) {
      onLog?.('[ClipCutter] ERROR: No valid JSON object found in text file');
      return { success: false, error: 'No valid JSON object found in the timing file.' };
    }

    onLog?.(`[ClipCutter] Parsed JSON: ${JSON.stringify(json, null, 2)}`);

    // ── 5. Extract clip timing ──────────────────────────────────────────
    const clip = json['clip'] as Record<string, unknown> | undefined;
    if (!clip || typeof clip !== 'object') {
      onLog?.('[ClipCutter] ERROR: JSON does not contain a "clip" object');
      return { success: false, error: 'JSON does not contain a "clip" object with start_time / end_time.' };
    }

    const rawStart = clip['start_time'];
    const rawEnd = clip['end_time'];

    if (rawStart === undefined || rawStart === null) {
      onLog?.('[ClipCutter] ERROR: clip.start_time is missing');
      return { success: false, error: 'clip.start_time is missing in JSON.' };
    }
    if (rawEnd === undefined || rawEnd === null) {
      onLog?.('[ClipCutter] ERROR: clip.end_time is missing');
      return { success: false, error: 'clip.end_time is missing in JSON.' };
    }

    const startSec = parseTimeToSeconds(String(rawStart));
    const endSec = parseTimeToSeconds(String(rawEnd));

    onLog?.(`[ClipCutter] Raw start_time: "${rawStart}" -> ${startSec}s`);
    onLog?.(`[ClipCutter] Raw end_time:   "${rawEnd}" -> ${endSec}s`);

    if (Number.isNaN(startSec)) {
      onLog?.(`[ClipCutter] ERROR: Could not parse start_time: "${rawStart}"`);
      return { success: false, error: `Could not parse start_time: "${rawStart}". Use MM:SS or HH:MM:SS format.` };
    }
    if (Number.isNaN(endSec)) {
      onLog?.(`[ClipCutter] ERROR: Could not parse end_time: "${rawEnd}"`);
      return { success: false, error: `Could not parse end_time: "${rawEnd}". Use MM:SS or HH:MM:SS format.` };
    }
    if (endSec <= startSec) {
      onLog?.(`[ClipCutter] ERROR: end_time (${endSec}s) must be greater than start_time (${startSec}s)`);
      return { success: false, error: `end_time (${endSec}s) must be greater than start_time (${startSec}s).` };
    }

    const clipDuration = endSec - startSec;
    onLog?.(`[ClipCutter] Clip: ${formatTimestamp(startSec)} -> ${formatTimestamp(endSec)} (${clipDuration.toFixed(1)}s)`);

    // ── 6. Run ffmpeg to cut the clip ───────────────────────────────────
    onProgress?.(15, 'Cutting video');

    const ext = path.extname(videoPath) || '.mp4';
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, `clip_output${ext}`);

    const ssTimestamp = formatTimestamp(startSec);
    const toTimestamp = formatTimestamp(endSec);

    const args: string[] = [
      '-y',
      '-ss', ssTimestamp,
      '-to', toTimestamp,
      '-i', videoPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ];

    onLog?.(`[ClipCutter] FFmpeg args: ffmpeg ${args.join(' ')}`);

    let sourceDurationSec = 0;

    const ok = await new Promise<boolean>((resolve) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      if (context.signal) {
        if (context.signal.aborted) {
          proc.kill();
          return resolve(false);
        }
        context.signal.addEventListener('abort', () => {
          proc.kill();
          resolve(false);
        }, { once: true });
      }

      proc.on('error', (err) => {
        onLog?.(`[ClipCutter] FFmpeg spawn error: ${err.message}`);
        resolve(false);
      });
      proc.on('close', (code) => {
        onLog?.(`[ClipCutter] FFmpeg exited with code ${code}`);
        resolve(code === 0);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split('\n')) {
          if (sourceDurationSec === 0) {
            const d = parseDuration(line);
            if (d > 0) {
              sourceDurationSec = d;
              onLog?.(`[ClipCutter] Source video duration: ${sourceDurationSec.toFixed(1)}s`);
            }
          }
          const t = parseTime(line);
          if (t > 0 && clipDuration > 0) {
            const pct = Math.min(99, Math.round(15 + (t / clipDuration) * 80));
            onProgress?.(pct, `Cutting ${Math.round((t / clipDuration) * 100)}%`);
          }
          if (line.toLowerCase().includes('error')) {
            onLog?.(`[ClipCutter] [FFmpeg] ${line.trim()}`);
          }
        }
      });

      setTimeout(() => {
        onLog?.('[ClipCutter] FFmpeg timed out (10 min), killing process');
        proc.kill('SIGKILL');
        resolve(false);
      }, 600_000);
    });

    if (!ok) {
      onLog?.('[ClipCutter] ERROR: FFmpeg clip cutting failed');
      return { success: false, error: 'FFmpeg failed to cut the video clip.' };
    }

    // ── 7. Verify output ────────────────────────────────────────────────
    try {
      const stat = await fs.stat(outputPath);
      onLog?.(`[ClipCutter] Output file created: ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
    } catch {
      onLog?.('[ClipCutter] ERROR: Output file was not created');
      return { success: false, error: 'FFmpeg completed but output file was not created.' };
    }

    onProgress?.(100, 'Done');
    onLog?.(`[ClipCutter] === Module complete. Clip: ${formatTimestamp(startSec)} -> ${formatTimestamp(endSec)} ===`);

    return {
      success: true,
      context: {
        currentVideoPath: outputPath,
      },
    };
  }
}
