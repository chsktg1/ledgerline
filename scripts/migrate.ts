import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261114)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    if (!(await client.query("SELECT 1 FROM schema_migrations WHERE name='001-ledger'")).rowCount) {
      await client.query(await readFile(new URL('../db/001-ledger.sql', import.meta.url), 'utf8'));
      await client.query("INSERT INTO schema_migrations(name) VALUES ('001-ledger')");
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
if (process.argv[1]?.endsWith('migrate.ts')) {
  migrate()
    .then(() => console.log('Migrations applied'))
    .finally(() => pool.end());
}
