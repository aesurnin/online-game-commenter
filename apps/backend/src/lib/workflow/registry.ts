import type { WorkflowModule, ModuleMeta } from './types.js';
import { VideoCompressorModule } from './modules/video-compressor.js';
import { VideoCropModule } from './modules/video-crop.js';
import { OpenRouterVisionModule } from './modules/openrouter-vision.js';

const modules = new Map<string, WorkflowModule>();

function register(m: WorkflowModule) {
  modules.set(m.meta.type, m);
}

register(new VideoCompressorModule());
register(new VideoCropModule());
register(new OpenRouterVisionModule());

export function getModule(type: string): WorkflowModule | undefined {
  return modules.get(type);
}

export function listModules(): ModuleMeta[] {
  return Array.from(modules.values()).map((m) => m.meta);
}
