import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';
import dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/videoplatform';

const client = postgres(connectionString);
export const db = drizzle(client, { schema });
