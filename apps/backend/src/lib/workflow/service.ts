import { uploadToR2, getObjectFromR2, listObjectsFromR2, deleteFromR2 } from '../r2.js';
import type { WorkflowDefinition } from './types.js';

const WORKFLOWS_PREFIX = 'workflows/';

export async function listWorkflows(): Promise<{ id: string; name?: string }[]> {
  const keys = await listObjectsFromR2(WORKFLOWS_PREFIX);
  const result: { id: string; name?: string }[] = [];
  for (const key of keys) {
    if (!key.endsWith('.json')) continue;
    const id = key.slice(WORKFLOWS_PREFIX.length).replace(/\.json$/, '');
    try {
      const def = await getWorkflow(id);
      result.push({ id, name: def?.name });
    } catch {
      result.push({ id });
    }
  }
  return result;
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition | null> {
  const key = `${WORKFLOWS_PREFIX}${id}.json`;
  try {
    const buf = await getObjectFromR2(key);
    return JSON.parse(buf.toString('utf8')) as WorkflowDefinition;
  } catch {
    return null;
  }
}

export async function saveWorkflow(id: string, def: WorkflowDefinition): Promise<void> {
  const key = `${WORKFLOWS_PREFIX}${id}.json`;
  const body = JSON.stringify({ ...def, id }, null, 2);
  await uploadToR2(key, Buffer.from(body, 'utf8'), 'application/json');
}

export async function deleteWorkflow(id: string): Promise<void> {
  const key = `${WORKFLOWS_PREFIX}${id}.json`;
  await deleteFromR2(key);
}
