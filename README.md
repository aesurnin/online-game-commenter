# Video Content Automation Platform

Platform for video analysis and social media content creation.

## Stack

- **Frontend**: Vite, React, TypeScript, Shadcn UI
- **Backend**: Node.js, Fastify, Drizzle ORM, Lucia Auth
- **Database**: PostgreSQL, Redis (Docker)

## Setup

1. Start Docker (Postgres + Redis):
   ```bash
   docker-compose up -d
   ```

2. Apply database schema:
   ```bash
   npm run db:push
   ```

3. Start everything:
   ```bash
   npm run dev
   ```
   This runs both backend (port 3000) and frontend (port 5173) in one terminal.

4. Open http://localhost:5173 (or 5174)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The project is conducted entirely in English (code, comments, UI).

## Storage (Cloudflare R2)

For S3-compatible object storage, see [docs/CLOUDFLARE_R2_SETUP.md](./docs/CLOUDFLARE_R2_SETUP.md) for credentials and setup.

## Credentials

There are no default credentials. Go to `/register` to create an account, then sign in with your email and password.
