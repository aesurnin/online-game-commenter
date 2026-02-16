import path from 'path';
import { config } from 'dotenv';

// Load local .env first
config();
// Load root .env as fallback for variables not set in local .env
config({ path: path.resolve(process.cwd(), '../../.env') });
