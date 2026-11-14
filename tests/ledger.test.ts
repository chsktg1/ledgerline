import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
// Never fall back to the application database: this suite truncates its tables.
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith('_test'))
  throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db.js');
const { migrate } = await import('../scripts/migrate.js');
const { transfer, reconcile, transaction } = await import('../src/ledger.js');
const { buildApp } = await import('../src/app.js');
const app = buildApp();
let a: string, b: string, equity: string;
const pay = (amount = '100') => ({ senderId: a, receiverId: b, amount, currency: 'USD' as const });
const post = (key: string, body = pay()) =>
  app.inject({
    method: 'POST',
    url: '/api/transfers',
    headers: { 'Idempotency-Key': key },
    payload: body,
  });
const balance = async (id: string) =>
  (await pool.query('SELECT balance FROM accounts WHERE id=$1', [id])).rows[0].balance as string;
beforeAll(async () => {
  await migrate();
  await app.ready();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE reconciliation_reports,entries,transfers,accounts RESTART IDENTITY CASCADE',
  );
  equity = (
    await pool.query(
      "INSERT INTO accounts(name,kind) VALUES ('Issuance equity','equity') RETURNING id",
    )
  ).rows[0].id;
  a = (await pool.query("INSERT INTO accounts(name) VALUES ('Alice') RETURNING id")).rows[0].id;
  b = (await pool.query("INSERT INTO accounts(name) VALUES ('Bob') RETURNING id")).rows[0].id;
  await transfer(
    'fixture-funding',
    { senderId: equity, receiverId: a, amount: '10000', currency: 'USD' },
    null,
    true,
  );
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
describe('real PostgreSQL ledger proofs', () => {
  it('PROOF 1: 100 concurrent debits cannot overdraw or lose an update', async () => {
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) => post(`concurrent-${i}`, pay('200'))),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(50);
    expect(responses.filter((r) => r.statusCode === 422)).toHaveLength(50);
    expect(await balance(a)).toBe('0');
    expect(await balance(b)).toBe('10000');
    const counts = (
      await pool.query(
        "SELECT count(*)::int AS transfers FROM transfers WHERE idempotency_key LIKE 'concurrent-%'",
      )
    ).rows[0];
    expect(counts.transfers).toBe(100);
    const audit = await reconcile();
    expect(audit.matches && audit.balanced).toBe(true);
    console.log(
      'PROOF 1 PASS | 100 concurrent requests | 50 completed | 50 rejected | sender=0 | receiver=10000 | no lost updates',
    );
  });
  it('PROOF 2: 10 simultaneous identical keys move money exactly once', async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => post('duplicate-key', pay('750'))),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(9);
    expect(new Set(responses.map((r) => r.json().transfer.id)).size).toBe(1);
    expect(await balance(a)).toBe('9250');
    expect(await balance(b)).toBe('750');
    const result = (
      await pool.query(
        "SELECT count(DISTINCT t.id)::int AS transfers,count(e.id)::int AS entries FROM transfers t JOIN entries e ON e.transfer_id=t.id WHERE t.idempotency_key='duplicate-key'",
      )
    ).rows[0];
    expect(result).toEqual({ transfers: 1, entries: 2 });
    console.log(
      'PROOF 2 PASS | 10 same-key requests | 1 transfer | 2 entries | 750 minor units moved exactly once',
    );
  });
  it('PROOF 3: reconciliation snapshots stay balanced during writes and rebuild every balance', async () => {
    const writes = Promise.all(
      Array.from({ length: 40 }, (_, i) => post(`snapshot-${i}`, pay('100'))),
    );
    for (let i = 0; i < 5; i++) {
      const report = await reconcile();
      expect(report.balanced).toBe(true);
      expect(report.matches).toBe(true);
      expect(report.mismatches).toEqual([]);
    }
    await writes;
    const r = await reconcile();
    expect(r.total_debits).toBe('14000');
    expect(r.total_credits).toBe('14000');
    expect(r.account_count).toBe(3);
    expect(
      r.balances.every(
        (v: { stored_balance: string; ledger_balance: string }) =>
          v.stored_balance === v.ledger_balance,
      ),
    ).toBe(true);
    console.log(
      'PROOF 3 PASS | 6 consistent snapshots | debits=14000 | credits=14000 | 3 rebuilt balances match | 0 mismatches',
    );
  });
  it('conflicts on a reused key with a different payload', async () => {
    expect((await post('same-key')).statusCode).toBe(201);
    const result = await post('same-key', pay('101'));
    expect(result.statusCode).toBe(409);
    expect(result.json().error).toBe('IDEMPOTENCY_CONFLICT');
    expect(await balance(b)).toBe('100');
  });
  it('persists overdraft failures and returns the original rejection on retry', async () => {
    const first = await post('overdraft', pay('10001'));
    expect(first.statusCode).toBe(422);
    const second = await post('overdraft', pay('10001'));
    expect(second.statusCode).toBe(422);
    expect(second.json().replayed).toBe(true);
    expect(second.json().transfer.id).toBe(first.json().transfer.id);
    const audit = await app.inject(`/api/transfers/${first.json().transfer.id}`);
    expect(audit.json().entries).toEqual([]);
    expect(await balance(a)).toBe('10000');
  });
  it('reverses with a new journal, preserves the original, and replays safely', async () => {
    const original = (await post('original', pay('2500'))).json().transfer;
    const reverse = () =>
      app.inject({
        method: 'POST',
        url: `/api/transfers/${original.id}/reverse`,
        headers: { 'Idempotency-Key': 'reverse-key' },
      });
    const first = await reverse();
    expect(first.statusCode).toBe(201);
    expect(first.json().transfer.reverse_of).toBe(original.id);
    const retry = await reverse();
    expect(retry.statusCode).toBe(200);
    expect(retry.json().transfer.id).toBe(first.json().transfer.id);
    expect(await balance(a)).toBe('10000');
    expect(await balance(b)).toBe('0');
    const detail = (await app.inject(`/api/transfers/${original.id}`)).json();
    expect(detail.status).toBe('completed');
    expect(detail.entries).toHaveLength(2);
    expect(detail.reversal_id).toBe(first.json().transfer.id);
    const again = await app.inject({
      method: 'POST',
      url: `/api/transfers/${original.id}/reverse`,
      headers: { 'Idempotency-Key': 'another-reversal' },
    });
    expect(again.statusCode).toBe(409);
  });
  it('permits exactly one of two concurrent reversal keys', async () => {
    const t = (await post('original')).json().transfer;
    const results = await Promise.all(
      ['r1', 'r2'].map((key) =>
        app.inject({
          method: 'POST',
          url: `/api/transfers/${t.id}/reverse`,
          headers: { 'Idempotency-Key': key },
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await balance(a)).toBe('10000');
  });
  it('keeps a failed reversal linked and allows a fresh key after funds return', async () => {
    const original = (await post('original')).json().transfer;
    await transfer('spend', { senderId: b, receiverId: a, amount: '100', currency: 'USD' });
    const reverse = (key: string) =>
      app.inject({
        method: 'POST',
        url: `/api/transfers/${original.id}/reverse`,
        headers: { 'Idempotency-Key': key },
      });
    const failed = await reverse('failed-reversal');
    expect(failed.statusCode).toBe(422);
    expect(failed.json().transfer.reverse_of).toBe(original.id);
    await post('refund');
    expect((await reverse('failed-reversal')).statusCode).toBe(422);
    expect((await reverse('fresh-reversal')).statusCode).toBe(201);
  });
  it('runs transfers in opposite directions without deadlocks or balance loss', async () => {
    await post('share', pay('5000'));
    const responses = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        post(
          `bidirectional-${i}`,
          i % 2 ? pay('10') : { senderId: b, receiverId: a, amount: '10', currency: 'USD' },
        ),
      ),
    );
    expect(responses.every((r) => r.statusCode === 201)).toBe(true);
    expect(await balance(a)).toBe('5000');
    expect(await balance(b)).toBe('5000');
  });
  it('finds deliberate cache corruption without silently repairing it', async () => {
    await pool.query('UPDATE accounts SET balance=balance+1 WHERE id=$1', [a]);
    const r = await reconcile();
    expect(r.balanced).toBe(true);
    expect(r.matches).toBe(false);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].stored_balance).toBe('10001');
    expect(r.mismatches[0].ledger_balance).toBe('10000');
  });
  it('Postgres rejects a single-sided journal at commit and rolls back the cache', async () => {
    await expect(
      transaction(async (c) => {
        const t = (
          await c.query(
            `INSERT INTO transfers(sender_id,receiver_id,amount,currency,idempotency_key,request_hash,status) VALUES ($1,$2,100,'USD','invalid','test','completed') RETURNING id`,
            [a, b],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO entries(transfer_id,account_id,direction,amount,currency) VALUES ($1,$2,'debit',100,'USD')",
          [t.id, a],
        );
      }),
    ).rejects.toThrow('Unbalanced or invalid journal');
    expect(await balance(a)).toBe('10000');
    expect(
      (await pool.query("SELECT 1 FROM transfers WHERE idempotency_key='invalid'")).rowCount,
    ).toBe(0);
  });
  it('Postgres rejects a balanced journal with the wrong accounts', async () => {
    await expect(
      transaction(async (c) => {
        const t = (
          await c.query(
            `INSERT INTO transfers(sender_id,receiver_id,amount,currency,idempotency_key,request_hash,status) VALUES ($1,$2,100,'USD','wrong-accounts','test','completed') RETURNING id`,
            [a, b],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO entries(transfer_id,account_id,direction,amount,currency) VALUES ($1,$2,'debit',100,'USD'),($1,$2,'credit',100,'USD')",
          [t.id, a],
        );
      }),
    ).rejects.toThrow('Unbalanced or invalid journal');
  });
  it('Postgres prevents edits or deletion of audit records', async () => {
    const t = (await post('immutable')).json().transfer;
    await expect(pool.query('DELETE FROM transfers WHERE id=$1', [t.id])).rejects.toThrow(
      'immutable',
    );
    await expect(
      pool.query('UPDATE entries SET amount=1 WHERE transfer_id=$1', [t.id]),
    ).rejects.toThrow('immutable');
    const r = await reconcile();
    await expect(
      pool.query('DELETE FROM reconciliation_reports WHERE id=$1', [r.id]),
    ).rejects.toThrow('immutable');
  });
  it('validates money, headers, currency, IDs, and self-transfers before writing', async () => {
    const bad = [
      { ...pay(), amount: 100 },
      { ...pay(), amount: '0' },
      { ...pay(), amount: '-1' },
      { ...pay(), amount: '1.50' },
      { ...pay(), amount: '9007199254740992' },
      { ...pay(), currency: 'EUR' },
      { ...pay(), receiverId: a },
      { ...pay(), senderId: 'bad-id' },
      { ...pay(), extra: 'field' },
    ];
    for (const body of bad) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/transfers',
        headers: { 'Idempotency-Key': randomUUID() },
        payload: body,
      });
      expect(r.statusCode).toBe(400);
    }
    expect(
      (await app.inject({ method: 'POST', url: '/api/transfers', payload: pay() })).statusCode,
    ).toBe(400);
  });
  it('creates zero-balance wallets and handles unknown accounts', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'New wallet' },
    });
    expect(result.statusCode).toBe(201);
    expect(result.json().balance).toBe('0');
    const read = await app.inject(`/api/accounts/${result.json().id}`);
    expect(read.statusCode).toBe(200);
    expect((await post('missing', { ...pay(), receiverId: randomUUID() })).statusCode).toBe(404);
  });
  it('does not expose equity as a payment wallet or allow API issuance', async () => {
    const wallets = (await app.inject('/api/accounts')).json().accounts;
    expect(wallets).toHaveLength(2);
    expect(wallets.some((v: { id: string }) => v.id === equity)).toBe(false);
    expect((await post('mint', { ...pay(), senderId: equity })).statusCode).toBe(422);
  });
});
