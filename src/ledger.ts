import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './db.js';
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export type Payment = { senderId: string; receiverId: string; amount: string; currency: 'USD' };
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  snapshot = false,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(snapshot ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function transfer(
  key: string,
  payment: Payment | null,
  reverseOf: string | null = null,
  allowEquity = false,
) {
  const hash = createHash('sha256')
    .update(JSON.stringify(reverseOf ? { reverseOf } : payment))
    .digest('hex');
  return transaction(async (c) => {
    // A transaction-scoped advisory lock serializes requests for the same key,
    // including retries that arrive before the first request has committed.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const prior = (await c.query('SELECT * FROM transfers WHERE idempotency_key=$1', [key]))
      .rows[0];
    if (prior) {
      if (prior.request_hash !== hash)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different request');
      return { transfer: prior, replayed: true };
    }
    if (reverseOf) {
      const original = (
        await c.query('SELECT * FROM transfers WHERE id=$1 FOR UPDATE', [reverseOf])
      ).rows[0];
      if (!original) throw new ApiError(404, 'NOT_FOUND', 'Original transfer not found');
      if (original.status !== 'completed' || original.reverse_of)
        throw new ApiError(
          409,
          'NOT_REVERSIBLE',
          'Only an original completed transfer can be reversed',
        );
      const reversed = (
        await c.query("SELECT 1 FROM transfers WHERE reverse_of=$1 AND status='completed'", [
          reverseOf,
        ])
      ).rowCount;
      if (reversed)
        throw new ApiError(409, 'ALREADY_REVERSED', 'This transfer already has a reversal');
      payment = {
        senderId: original.receiver_id,
        receiverId: original.sender_id,
        amount: original.amount,
        currency: original.currency,
      };
    }
    const p = payment!;
    // Stable ordering prevents deadlocks on transfers moving in opposite directions.
    const accounts = (
      await c.query('SELECT * FROM accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
        [p.senderId, p.receiverId],
      ])
    ).rows;
    if (accounts.length !== 2) throw new ApiError(404, 'NOT_FOUND', 'Sender or receiver not found');
    const sender = accounts.find((a) => a.id === p.senderId)!;
    if (accounts.some((a) => a.currency !== p.currency))
      throw new ApiError(422, 'CURRENCY_MISMATCH', 'Account currencies must match');
    if (!allowEquity && accounts.some((a) => a.kind === 'equity'))
      throw new ApiError(422, 'SYSTEM_ACCOUNT', 'System equity is not a payment wallet');
    const rejected = sender.kind !== 'equity' && BigInt(sender.balance) < BigInt(p.amount);
    // A rejected reversal remains linked but does not consume the completed reversal slot.
    const result = (
      await c.query(
        `INSERT INTO transfers(sender_id,receiver_id,amount,currency,idempotency_key,request_hash,status,failure_code,reverse_of)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          p.senderId,
          p.receiverId,
          p.amount,
          p.currency,
          key,
          hash,
          rejected ? 'rejected' : 'completed',
          rejected ? 'INSUFFICIENT_FUNDS' : null,
          reverseOf,
        ],
      )
    ).rows[0];
    if (!rejected) {
      await c.query(
        `INSERT INTO entries(transfer_id,account_id,direction,amount,currency) VALUES ($1,$2,'debit',$4,$5),($1,$3,'credit',$4,$5)`,
        [result.id, p.senderId, p.receiverId, p.amount, p.currency],
      );
    }
    return { transfer: result, replayed: false };
  });
}
export async function reconcile() {
  return transaction(async (c) => {
    const balances = (
      await c.query(`SELECT a.id,a.name,a.balance::text AS stored_balance,
      COALESCE(sum(CASE WHEN e.direction='credit' THEN e.amount::numeric ELSE -e.amount::numeric END),0)::text AS ledger_balance
      FROM accounts a LEFT JOIN entries e ON e.account_id=a.id GROUP BY a.id ORDER BY a.id`)
    ).rows;
    const mismatches = balances.filter((a) => a.stored_balance !== a.ledger_balance);
    const totals = (
      await c.query(`SELECT COALESCE(sum(amount) FILTER (WHERE direction='debit'),0)::text AS debits,
      COALESCE(sum(amount) FILTER (WHERE direction='credit'),0)::text AS credits FROM entries`)
    ).rows[0];
    return (
      await c.query(
        `INSERT INTO reconciliation_reports(balanced,matches,total_debits,total_credits,account_count,mismatches,balances)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          totals.debits === totals.credits,
          mismatches.length === 0,
          totals.debits,
          totals.credits,
          balances.length,
          JSON.stringify(mismatches),
          JSON.stringify(balances),
        ],
      )
    ).rows[0];
  }, true);
}
