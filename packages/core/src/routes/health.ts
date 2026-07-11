/**
 * Health check route.
 *
 * Unauthenticated liveness probe used by Docker HEALTHCHECK / Kubernetes
 * readiness probes. Returns 200 with a minimal JSON payload and nothing
 * else — no upstream calls, no token checks. The goal is: "is the Fastify
 * process alive and accepting requests?".
 */

import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (_request, reply) => {
    reply.redirect('/health');
  });

  app.get('/health', async (_request, reply) => {
    reply.send({ status: 'ok' });
  });
}
