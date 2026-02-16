import type { Config } from 'drizzle-kit';
import path from 'path';
import { config } from 'dotenv';
config({ path: path.resolve(process.cwd(), '../../.env') });
config();

export default {
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  driver: 'pg',
  dbCredentials: {
    connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/videoplatform',
  },
} satisfies Config;
