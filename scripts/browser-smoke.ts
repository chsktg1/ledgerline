import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
// Run against a locally seeded development server; this creates real audit records.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(process.env.BASE_URL ?? 'http://127.0.0.1:3000');
  await page.getByRole('heading', { name: 'Your money in motion.' }).waitFor();
  await page.getByRole('heading', { name: 'Operating wallet', exact: true }).waitFor();
  await page.locator('select').nth(0).selectOption({ label: 'Operating wallet' });
  await page.locator('select').nth(1).selectOption({ label: 'Marketplace payouts' });
  await page.getByLabel('Amount in USD').fill('12.34');
  await page.getByRole('button', { name: 'Transfer funds' }).click();
  await page.getByRole('status').filter({ hasText: 'Transfer completed' }).waitFor();
  await page.locator('tbody tr').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Journal entries' }).waitFor();
  assert.equal(await dialog.locator('.entry').count(), 2);
  await dialog.getByRole('button', { name: 'Reverse transfer' }).click();
  await page.getByRole('status').filter({ hasText: 'Reversal posted' }).waitFor();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Run reconciliation', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Reconciliation report saved' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.screenshot({ path: 'docs/dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Reconciliation', exact: true }).click();
  await page.locator('details').first().locator('summary').click();
  await page.locator('.report-body').first().getByText('Total debits', { exact: false }).waitFor();
  assert.ok(
    (await page.locator('.report-body').first().getByText('Match', { exact: true }).count()) > 0,
  );
  assert.equal(
    await page.locator('.report-body').first().getByText('Mismatch', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const uniqueName = `Browser wallet ${Date.now()}`;
  await page.getByLabel('Account name').fill(uniqueName);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByRole('status').filter({ hasText: 'Account created' }).waitFor();
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('heading', { name: uniqueName }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('heading', { name: 'Your money in motion.' }).waitFor();
  await page.screenshot({ path: 'docs/mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'BROWSER PASS | transfer | 2 audit entries | reversal | reconciliation report | create account | mobile 390px | no page errors',
  );
} finally {
  await browser.close();
}
