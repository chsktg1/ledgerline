import Fastify from 'fastify';
import { z } from 'zod';
import { pool } from './db.js';
import { ApiError, transfer, reconcile } from './ledger.js';
const uuid = z.uuid().transform((s) => s.toLowerCase());
const paymentSchema = z
  .object({
    senderId: uuid,
    receiverId: uuid,
    amount: z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/)
      .pipe(z.string().refine((s) => BigInt(s) <= 9007199254740991n)),
    currency: z.literal('USD'),
  })
  .strict()
  .refine((p) => p.senderId !== p.receiverId, { message: 'Sender and receiver must differ' });
const keySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/);
export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', bodyLimit: 16384 });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues });
    if (err instanceof ApiError)
      return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (
      err instanceof Error &&
      'statusCode' in err &&
      typeof err.statusCode === 'number' &&
      err.statusCode < 500
    )
      return reply.code(err.statusCode).send({ error: 'BAD_REQUEST', message: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'An internal error occurred' });
  });
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/accounts', async () => ({
    accounts: (
      await pool.query("SELECT * FROM accounts WHERE kind='wallet' ORDER BY created_at,id")
    ).rows,
  }));
  app.post('/api/accounts', async (req, reply) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(80), currency: z.literal('USD').default('USD') })
      .strict()
      .parse(req.body);
    const account = (
      await pool.query('INSERT INTO accounts(name,currency) VALUES ($1,$2) RETURNING *', [
        body.name,
        body.currency,
      ])
    ).rows[0];
    return reply.code(201).send(account);
  });
  app.get('/api/accounts/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const a = (await pool.query("SELECT * FROM accounts WHERE id=$1 AND kind='wallet'", [id]))
      .rows[0];
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'Account not found');
    return a;
  });
  app.post('/api/transfers', async (req, reply) => {
    const key = keySchema.parse(req.headers['idempotency-key']);
    const result = await transfer(key, paymentSchema.parse(req.body));
    return reply
      .header('Idempotency-Replayed', String(result.replayed))
      .code(result.transfer.status === 'rejected' ? 422 : result.replayed ? 200 : 201)
      .send(result);
  });
  app.get('/api/transfers', async (req) => {
    const { limit, offset } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .parse(req.query);
    const data = await pool.query(
      `SELECT t.*,a.name AS sender_name,b.name AS receiver_name,r.id AS reversal_id
      FROM transfers t JOIN accounts a ON a.id=t.sender_id JOIN accounts b ON b.id=t.receiver_id
      LEFT JOIN transfers r ON r.reverse_of=t.id AND r.status='completed' ORDER BY t.created_at DESC,t.id DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return { transfers: data.rows, limit, offset };
  });
  app.get('/api/transfers/:id', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = (
      await pool.query(
        `SELECT t.*,r.id AS reversal_id FROM transfers t LEFT JOIN transfers r ON r.reverse_of=t.id AND r.status='completed' WHERE t.id=$1`,
        [id],
      )
    ).rows[0];
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'Transfer not found');
    return {
      ...t,
      entries: (await pool.query('SELECT * FROM entries WHERE transfer_id=$1 ORDER BY id', [id]))
        .rows,
    };
  });
  app.post('/api/transfers/:id/reverse', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const result = await transfer(keySchema.parse(req.headers['idempotency-key']), null, id);
    return reply
      .header('Idempotency-Replayed', String(result.replayed))
      .code(result.transfer.status === 'rejected' ? 422 : result.replayed ? 200 : 201)
      .send(result);
  });
  app.post('/api/reconciliation', async (_req, reply) => reply.code(201).send(await reconcile()));
  app.get('/api/reconciliation', async () => ({
    reports: (
      await pool.query('SELECT * FROM reconciliation_reports ORDER BY created_at DESC,id LIMIT 50')
    ).rows,
  }));
  return app;
}
