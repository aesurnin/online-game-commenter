import '../load-env.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/videoplatform';

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
