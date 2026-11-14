import { pool } from '../src/db.js';
import { transfer, reconcile } from '../src/ledger.js';
import { migrate } from './migrate.js';
try {
  await migrate();
  await pool.query(
    "INSERT INTO accounts(id,name,kind) VALUES ('00000000-0000-4000-8000-000000000001','Demo issuance equity','equity') ON CONFLICT DO NOTHING",
  );
  const names = ['Operating wallet', 'Marketplace payouts', 'Reserve wallet'];
  for (let i = 0; i < names.length; i++) {
    const id = `10000000-0000-4000-8000-00000000000${i + 1}`;
    await pool.query('INSERT INTO accounts(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      id,
      names[i],
    ]);
    await transfer(
      `seed-wallet-${i + 1}`,
      {
        senderId: '00000000-0000-4000-8000-000000000001',
        receiverId: id,
        amount: ['2500000', '840000', '1200000'][i],
        currency: 'USD',
      },
      null,
      true,
    );
  }
  await reconcile();
  console.log('Demo wallets funded through balanced issuance entries. Seed can be rerun safely.');
} finally {
  await pool.end();
}
