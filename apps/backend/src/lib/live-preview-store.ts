/**
 * In-memory store for live preview frames from the screencast worker.
 * Worker POSTs JPEG; we keep the latest per videoId for GET by the frontend.
 */
const store = new Map<string, { buffer: Buffer; updatedAt: number }>();
const logged = new Set<string>();

const MAX_AGE_MS = 60_000; // drop frames older than 1 min

export function setFrame(videoId: string, buffer: Buffer): void {
  if (!logged.has(videoId)) {
    console.log('[LivePreview] First frame received for', videoId.slice(0, 8));
    logged.add(videoId);
  }
  store.set(videoId, { buffer, updatedAt: Date.now() });
}

export function getFrame(videoId: string): Buffer | null {
  const entry = store.get(videoId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > MAX_AGE_MS) {
    store.delete(videoId);
    return null;
  }
  return entry.buffer;
}

export function clearFrame(videoId: string): void {
  store.delete(videoId);
}
