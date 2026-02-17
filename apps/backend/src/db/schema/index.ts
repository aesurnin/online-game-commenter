import { integer, pgTable, text, timestamp, uuid, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('user', {
  id: text('id').primaryKey(),
  email: text('email').unique(),
  username: text('username'),
  password_hash: text('password_hash'),
  created_at: timestamp('created_at').defaultNow(),
});

export const sessions = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', {
    withTimezone: true,
    mode: 'date'
  }).notNull()
});

export const projects = pgTable('project', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  ownerId: text('owner_id').references(() => users.id).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const videoEntities = pgTable('video_entity', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id').references(() => projects.id).notNull(),
  status: text('status').default('draft'), // draft, processing, ready, failed
  displayName: text('display_name'),
  metadata: jsonb('metadata').default({}),
  sourceUrl: text('source_url'),
  previewUrl: text('preview_url'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const providerTemplates = pgTable('provider_template', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  urlPattern: text('url_pattern').notNull(), // e.g. "bgaming-network.com" - matched as substring
  playSelectors: jsonb('play_selectors').$type<string[]>().default([]),
  endSelectors: jsonb('end_selectors').$type<string[]>().default([]),
  idleValueSelector: text('idle_value_selector'),
  idleSeconds: integer('idle_seconds').default(40),
  consoleEndPatterns: jsonb('console_end_patterns').$type<string[]>().default([]),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
