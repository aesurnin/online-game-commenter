import { db } from '../db/index.js';
import { appEnv } from '../db/schema/index.js';

/**
 * Load app_env from DB into process.env so they are available project-wide.
 * Call after load-env; DB values override .env. Call refresh() after API set/delete.
 */
export async function loadAppEnvIntoProcess(): Promise<void> {
  const rows = await db.select().from(appEnv);
  for (const row of rows) {
    process.env[row.key] = row.value;
  }
}

/**
 * After setting or deleting a variable via API, update process.env to match DB.
 */
export async function refreshAppEnvInProcess(): Promise<void> {
  await loadAppEnvIntoProcess();
}
