import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { pool } from './db.js';
const app = buildApp();
const webRoot = fileURLToPath(new URL('../dist', import.meta.url));
if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot });
const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
try {
  await app.listen({
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
  });
} catch (e) {
  app.log.error(e);
  await shutdown();
  process.exitCode = 1;
}
