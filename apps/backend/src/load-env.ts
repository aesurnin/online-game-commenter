import path from 'path';
import { config } from 'dotenv';

// Load root .env first (when running from apps/backend in monorepo)
config({ path: path.resolve(process.cwd(), '../../.env') });
config(); // local .env overrides
