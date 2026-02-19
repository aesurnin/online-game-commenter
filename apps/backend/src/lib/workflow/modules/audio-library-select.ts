import fs from 'fs/promises';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { contentLibraryItems } from '../../../db/schema/index.js';
import { getObjectFromR2 } from '../../r2.js';
import type { WorkflowContext, WorkflowModule, ModuleRunResult } from '../types.js';

export const audioLibrarySelectMeta = {
  type: 'audio.library.select',
  label: 'Audio from Library',
  description: 'Select an audio file from the global content library and output it for use in other modules',
  category: 'Audio',
  quickParams: ['mode', 'audioId', 'randomTag'],
  inputSlots: [],
  outputSlots: [
    { key: 'audio', label: 'Audio', kind: 'file' as const },
  ],
  paramsSchema: [
    {
      key: 'mode',
      label: 'Selection mode',
      type: 'string' as const,
      default: 'fixed',
      options: [
        { value: 'fixed', label: 'Fixed (choose item)' },
        { value: 'random', label: 'Random (from all)' },
        { value: 'random_by_tag', label: 'Random by tag' },
      ],
    },
    { key: 'audioId', label: 'Audio', type: 'string' as const, default: '' },
    { key: 'randomTag', label: 'Tag (for random by tag)', type: 'string' as const, default: '' },
  ],
};

function pickRandom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

export class AudioLibrarySelectModule implements WorkflowModule {
  readonly meta = audioLibrarySelectMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;

    const mode = String(params.mode ?? 'fixed').trim() as 'fixed' | 'random' | 'random_by_tag';
    const audioId = String(params.audioId ?? '').trim();
    const randomTag = String(params.randomTag ?? '').trim();

    let item: typeof contentLibraryItems.$inferSelect | undefined;

    if (mode === 'fixed') {
      if (!audioId) {
        onLog?.('[Audio Library Select] ERROR: No audio selected. Choose an item from the library.');
        return { success: false, error: 'No audio selected. Choose an item from the library.' };
      }
      onLog?.(`[Audio Library Select] Fetching item: ${audioId}`);
      const [found] = await db.select().from(contentLibraryItems).where(
        and(eq(contentLibraryItems.id, audioId), eq(contentLibraryItems.type, 'audio'))
      );
      item = found;
      if (!item) {
        onLog?.(`[Audio Library Select] ERROR: Item not found: ${audioId}`);
        return { success: false, error: `Audio item not found: ${audioId}` };
      }
    } else {
      onProgress?.(0, 'Loading from library');
      let items = await db.select().from(contentLibraryItems).where(eq(contentLibraryItems.type, 'audio'));

      if (mode === 'random_by_tag') {
        if (!randomTag) {
          onLog?.('[Audio Library Select] ERROR: Tag is required for "Random by tag" mode.');
          return { success: false, error: 'Tag is required for "Random by tag" mode.' };
        }
        items = items.filter((i) => {
          const tags = (i.tags ?? []) as string[];
          return tags.includes(randomTag);
        });
        onLog?.(`[Audio Library Select] Random from ${items.length} items with tag "${randomTag}"`);
      } else {
        onLog?.(`[Audio Library Select] Random from ${items.length} items`);
      }

      item = pickRandom(items);
      if (!item) {
        const msg = mode === 'random_by_tag'
          ? `No audio items found with tag "${randomTag}". Add items and assign the tag.`
          : 'No audio items in library. Upload some first.';
        onLog?.(`[Audio Library Select] ERROR: ${msg}`);
        return { success: false, error: msg };
      }
      onLog?.(`[Audio Library Select] Selected: ${item.name} (${item.id})`);
    }

    onProgress?.(30, 'Downloading audio');

    let buffer: Buffer;
    try {
      buffer = await getObjectFromR2(item.r2Key);
    } catch (err) {
      onLog?.(`[Audio Library Select] ERROR: Failed to download from R2: ${err}`);
      return { success: false, error: 'Failed to download audio from storage' };
    }

    const ext = path.extname(item.r2Key) || '.mp3';
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, `output${ext}`);

    onProgress?.(80, 'Writing file');

    try {
      await fs.writeFile(outputPath, buffer);
    } catch (err) {
      onLog?.(`[Audio Library Select] ERROR: Failed to write file: ${err}`);
      return { success: false, error: 'Failed to write audio file' };
    }

    onLog?.(`[Audio Library Select] Output: ${outputPath}`);
    onProgress?.(100, 'Done');

    return {
      success: true,
      context: {
        currentAudioPath: outputPath,
      },
    };
  }
}
