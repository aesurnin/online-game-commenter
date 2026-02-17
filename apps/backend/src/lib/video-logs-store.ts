export type VideoLogEntry = {
  id: string;
  timestamp: string;
  message: string;
};

const logsByVideoId = new Map<string, VideoLogEntry[]>();

const MAX_LOGS_PER_VIDEO = 500;

export function appendVideoLog(videoId: string, message: string): void {
  const logs = logsByVideoId.get(videoId) ?? [];
  logs.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message,
  });
  if (logs.length > MAX_LOGS_PER_VIDEO) {
    logs.splice(0, logs.length - MAX_LOGS_PER_VIDEO);
  }
  logsByVideoId.set(videoId, logs);
}

export function getVideoLogs(videoId: string): VideoLogEntry[] {
  return logsByVideoId.get(videoId) ?? [];
}

export function clearVideoLogs(videoId: string): void {
  logsByVideoId.delete(videoId);
}
