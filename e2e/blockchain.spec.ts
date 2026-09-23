import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * The NFT drop workshop (entry 076), through the interface: every blockchain
 * piece on its card and in the results, a gas rate typed in turning the
 * contract's line from unpriced into a number, and a saved run keeping the
 * chain's numbers across a reload.
 */

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function openFresh(page: Page) {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('aparecium');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
}

async function runToResult(page: Page) {
  const runButton = page.getByRole('button', { name: 'Run simulation' });
  if (await runButton.isVisible()) await runButton.click();
  await expect
    .poll(() => page.evaluate(() => {
      const s = window.aparecium!.store.getState();
      return s.latestRun !== null && !s.resultsStale && !s.running;
    }), { timeout: 60_000 })
    .toBe(true);
}

const card = (page: Page, name: string) => page.locator('.react-flow__node').filter({ hasText: name });

test('the NFT drop runs every blockchain piece, and gas is priced once you enter a rate', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Blockchain workshop: an NFT drop', { exact: true }).click();
  await expect(card(page, 'NFT contract')).toBeVisible();
  await page.evaluate(() => window.aparecium!.store.getState().setContinuous(false));
  await runToResult(page);

  // ---- Each piece did its own job ----------------------------------------------
  const run = await page.evaluate(() => {
    const r = window.aparecium!.store.getState().latestRun!.result;
    const by = (kind: string) => r.chainServices!.find((s) => s.kind === kind)!;
    return { signed: by('wallet').details.signed, transactions: by('smartContract').details.transactions,
      reads: by('smartContract').details.reads, passed: by('wallet').details.passedThrough,
      oracle: by('oracle').details.included, indexed: by('indexer').details.blocksIndexed,
      rpc: r.servers.find((s) => s.kind === 'rpcNode')!.admitted };
  });
  expect(run.transactions).toBe(run.signed);
  expect(run.reads).toBe(run.passed);
  expect(run.oracle).toBeGreaterThan(0);
  expect(run.indexed).toBeGreaterThan(0);
  expect(run.rpc).toBe(run.signed! + run.passed!);
  await expect(card(page, 'NFT contract')).toContainText(/in blocks · fee ×[\d.]+/);
  await expect(card(page, 'Indexer')).toContainText(/queries · [\d.]+ s lag/);
  await expect(card(page, 'Price oracle')).toContainText(/updates · [\d.]+ s oldest/);

  // ---- Gas: measured, unpriced until a rate is entered, then a number -----------
  const gasLine = () => page.evaluate(() => window.aparecium!.store.getState().latestRun!.cost.lines
    .find((l) => l.nodeId === 'contract' && l.chargeType === 'gas')!);
  const before = await gasLine();
  expect(before.unpriced).toBe(true);
  expect(before.unpricedReason).toMatch(/base fee in gwei/);
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'contract' }));
  const rate = page.getByLabel(/Gas rate/).first();
  await rate.fill('30');
  await rate.blur();
  await runToResult(page);
  await expect.poll(async () => (await gasLine()).unpriced).toBe(false);
  const after = await gasLine();
  expect(after.edited).toBe(true);
  expect(Number(after.monthly)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Expand results' }).click();
  await page.getByRole('tab', { name: 'Cost' }).click();
  await expect(page.getByText('Gas', { exact: true }).first()).toBeVisible();

  // ---- A kept run keeps the chain's numbers across a reload ----------------------
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.keepLatestRun(); s.stopSimulation(); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  const kept = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.chainServices);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.aparecium?.store.getState().ready === true)).toBe(true);
  expect(await page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.chainServices)).toEqual(kept);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
