import { FastifyPluginAsync } from 'fastify';
import { lucia } from '../lib/auth.js';
import { generateId } from 'lucia';
import { Argon2id } from 'oslo/password';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import z from 'zod';

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/register', async (request, reply) => {
    const schema = z.object({
      username: z.string().min(3),
      password: z.string().min(6),
      email: z.string().email(),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(body.error);
    }

    const { username, password, email } = body.data;

    const hashedPassword = await new Argon2id().hash(password);
    const userId = generateId(15);

    try {
      await db.insert(users).values({
        id: userId,
        username,
        email,
        password_hash: hashedPassword
      });

      const session = await lucia.createSession(userId, {});
      const sessionCookie = lucia.createSessionCookie(session.id);
      
      reply.header('Set-Cookie', sessionCookie.serialize());
      return reply.status(201).send({ userId });
    } catch (e) {
      // Check for duplicate user/email (simplified)
      return reply.status(500).send({ error: "User creation failed" });
    }
  });

  fastify.post('/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    });

    const body = schema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(body.error);
    }

    const { email, password } = body.data;

    const existingUser = await db.query.users.findFirst({
        where: eq(users.email, email)
    });

    if (!existingUser) {
      return reply.status(400).send({ error: "Invalid credentials" });
    }

    const validPassword = await new Argon2id().verify(existingUser.password_hash!, password);
    if (!validPassword) {
      return reply.status(400).send({ error: "Invalid credentials" });
    }

    const session = await lucia.createSession(existingUser.id, {});
    const sessionCookie = lucia.createSessionCookie(session.id);

    reply.header('Set-Cookie', sessionCookie.serialize());
    return reply.status(200).send({ userId: existingUser.id });
  });

  fastify.get('/me', async (request, reply) => {
    if (!request.user) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    return reply.send({
      userId: request.user.id,
      username: request.user.username,
      email: request.user.email,
    });
  });

  fastify.post('/logout', async (request, reply) => {
      // In a real app, you'd get the session ID from the cookie/context
      // await lucia.invalidateSession(sessionId);
      const sessionCookie = lucia.createBlankSessionCookie();
      reply.header("Set-Cookie", sessionCookie.serialize());
      return reply.send({ success: true });
  });
};

export default authRoutes;
