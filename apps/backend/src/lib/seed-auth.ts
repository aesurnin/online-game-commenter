import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { Argon2id } from 'oslo/password';
import { generateId } from 'lucia';

/**
 * Seeds users from AUTH_USERS env var.
 * Format: email1:password1,email2:password2
 * Creates users in DB if they don't exist (by email).
 */
export async function seedAuthUsers(): Promise<void> {
  const authUsers = process.env.AUTH_USERS;
  if (!authUsers?.trim()) {
    console.warn('[Seed] AUTH_USERS not set — no users will be seeded');
    return;
  }

  const pairs = authUsers.split(',').map((s) => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf(':');
    if (idx <= 0 || idx === pair.length - 1) {
      console.warn(`[Seed] Invalid AUTH_USERS entry: ${pair}`);
      continue;
    }
    const email = pair.slice(0, idx).trim();
    const password = pair.slice(idx + 1).trim();
    if (!email || !password) {
      console.warn(`[Seed] Invalid AUTH_USERS entry: ${pair}`);
      continue;
    }

    const existing = await db.query.users.findFirst({
      where: eq(users.email, email),
    });
    if (existing) continue;

    const hashedPassword = await new Argon2id().hash(password);
    const userId = generateId(15);
    await db.insert(users).values({
      id: userId,
      email,
      username: email.split('@')[0],
      password_hash: hashedPassword,
    });
    console.log(`[Seed] Created user: ${email}`);
  }
}
