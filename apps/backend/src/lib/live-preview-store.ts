const store = new Map<string, { buffer: Buffer; updatedAt: number }>();
const MAX_AGE_MS = 60_000;

export function setFrame(videoId: string, buffer: Buffer): void {
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
