# Writing Workflow Modules

This guide explains how to create new modules for the workflow engine. A module is a self-contained unit of work (e.g., video processing, AI generation, file manipulation) that can be chained together in a workflow.

## Overview

All modules must implement the `WorkflowModule` interface defined in `types.ts`. A module consists of two main parts:
1. **Metadata (`meta`)**: Defines the module's identity, UI configuration, inputs, and outputs.
2. **Execution Logic (`run`)**: The actual code that performs the task.

## Step-by-Step Guide

### 1. Create the Module File
Create a new file in `apps/backend/src/lib/workflow/modules/`, e.g., `my-new-module.ts`.

### 2. Define Metadata
The metadata tells the frontend how to render the configuration form and the runner how to connect data streams.

```typescript
import type { WorkflowModule, ModuleMeta } from '../types.js';

export const myModuleMeta: ModuleMeta = {
  type: 'my.module.type',       // Unique identifier
  label: 'My New Module',       // Display name in UI
  description: 'Does something amazing',
  
  // inputSlots: Files/data needed by this module
  inputSlots: [
    { key: 'video', label: 'Input Video', kind: 'video' }
  ],
  
  // outputSlots: Files/data produced by this module
  outputSlots: [
    { key: 'processedVideo', label: 'Processed Video', kind: 'video' }
  ],
  
  // paramsSchema: UI form fields for user configuration
  paramsSchema: [
    { 
      key: 'intensity', 
      label: 'Intensity', 
      type: 'number', 
      default: 0.5, 
      min: 0, 
      max: 1 
    },
    {
      key: 'mode',
      label: 'Mode',
      type: 'string',
      options: [
        { value: 'fast', label: 'Fast' },
        { value: 'quality', label: 'High Quality' }
      ]
    }
  ]
};
```

### 3. Implement the Class
Implement the `WorkflowModule` interface.

```typescript
import fs from 'fs/promises';
import path from 'path';
import type { WorkflowContext, ModuleRunResult } from '../types.js';

export class MyNewModule implements WorkflowModule {
  readonly meta = myModuleMeta;

  async run(context: WorkflowContext, params: Record<string, unknown>): Promise<ModuleRunResult> {
    const { onProgress, onLog } = context;
    
    // 1. Get Inputs
    // context.currentVideoPath usually holds the video from the previous step
    const inputPath = context.currentVideoPath;
    
    // 2. Parse Params
    const intensity = Number(params.intensity ?? 0.5);
    
    onLog?.(`Starting processing with intensity ${intensity}`);
    onProgress?.(10, 'Initializing...');

    // 3. Prepare Output Path
    // Use context.moduleCacheDir or context.tempDir
    const outDir = context.moduleCacheDir ?? context.tempDir;
    const outputPath = path.join(outDir, `output-${Date.now()}.mp4`);

    try {
      // 4. Perform Logic (Example: pseudo-code)
      // await performHeavyTask(inputPath, outputPath);
      
      onProgress?.(100, 'Done');
      
      // 5. Return Result
      // Update context with new paths/variables
      return {
        success: true,
        context: {
          currentVideoPath: outputPath, // Pass this to the next module
          // You can also set custom variables:
          // variables: { 'myKey': 'someValue' }
        }
      };
    } catch (error) {
      onLog?.(`Error: ${error}`);
      return { success: false, error: String(error) };
    }
  }
}
```

### 4. Register the Module
Add your module to `apps/backend/src/lib/workflow/registry.ts`:

```typescript
import { MyNewModule } from './modules/my-new-module.js';

// ...
register(new MyNewModule());
```

## Best Practices

- **File Paths**: Always use absolute paths. `context.tempDir` is guaranteed to exist.
- **Cleanup**: The runner handles temporary directory cleanup, but be mindful of creating large intermediate files.
- **Progress**: Call `onProgress(percent, message)` frequently to keep the user informed.
- **Logging**: Use `onLog(message)` for debugging info that should be visible in the UI logs.
- **FFmpeg**: If using FFmpeg, consider using the `spawn` pattern seen in `video-compressor.ts` or `video-crop.ts` to parse progress from stderr.
- **Idempotency**: Modules should ideally be idempotent given the same inputs and parameters.

## Paid API Modules (Cost Tracking)

**All modules that call paid APIs must save `metadata.json`** in their cache directory so the workflow can aggregate total cost. Use one of two formats:

### Option A: Token-based (OpenRouter, LLM)

When the API returns token usage:

```typescript
const metadata = {
  model: 'openai/gpt-4o',  // or whatever model was used
  tokenUsage: { prompt_tokens, completion_tokens, total_tokens },
};
await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
```

The runner calculates cost from OpenRouter pricing.

### Option B: Direct cost (ElevenLabs, etc.)

When the API uses different units (characters, seconds, etc.), **the module calculates and writes cost itself**:

```typescript
const costUsd = 0.045;  // from API response or your pricing calculation
const metadata = {
  costUsd,
  // optional: provider-specific details for display
  provider: 'elevenlabs',
  characters: 1500,
};
await fs.writeFile(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
```

**Unified format:** The runner reads `metadata.json` from every step. If `costUsd` is present, it uses it. Otherwise, if `tokenUsage` + `model` are present, it calculates from OpenRouter pricing. All costs are summed into the workflow total.

### Execution time

**The runner automatically writes `executionTimeMs`** to each step's `metadata.json` after the module completes. No module code is required. The value is the wall-clock duration in milliseconds. Total execution time is aggregated and shown in the workflow panel.

## Special Features

### Interactive UI (Custom Actions)
If your module requires custom interactive UI (like the Crop tool):
1. Add a specific `type` to your module (e.g., `video.crop`).
2. Update `apps/frontend/src/components/WorkflowEditor.tsx` to check for this `module.type` and render a custom button/modal.
3. If needed, create a dedicated backend endpoint in `apps/backend/src/routes/workflows.ts` for preview/test actions (like `test-crop`).
