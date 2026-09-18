import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * The second five — serverless function, read replica, key-value store,
 * object storage, pub/sub topic — in a real browser.
 *
 * The engine tests prove the arithmetic. What this proves is that a person
 * can get to it: the five are in the palette, the two templates build and
 * run, each component's own number reaches its card and the results sheet,
 * and the cost sheet prices them with the verified rates.
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

test('the serverless template bills by the request and the second alive', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  for (const name of ['Serverless Function', 'Read Replica', 'Key-Value Store', 'Object Storage', 'Pub/Sub Topic']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }

  await page.getByText('Serverless API: gateway, function, key-value store, topic').click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'API function' })).toBeVisible();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const summary = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    const fn = result.servers.find((s) => s.nodeId === 'function_1')!;
    const kv = result.stations.find((s) => s.kind === 'kvStore')!;
    const bucket = result.stations.find((s) => s.kind === 'objectStorage')!;
    const topic = result.stations.find((s) => s.kind === 'pubsub')!;
    return {
      offered: result.offered,
      completed: result.completed,
      rejected: result.rejected,
      fn: { kind: fn.kind, completed: fn.completed, cold: fn.coldStarts ?? 0, throttled: fn.throttled ?? 0, busy: fn.busyMsTotal ?? 0 },
      kv: { reads: kv.reads ?? 0, writes: kv.writes ?? 0 },
      bucket: { reads: bucket.reads ?? 0, writes: bucket.writes ?? 0 },
      topic: { published: topic.operations, dropped: topic.dropped ?? 0 },
      listeners: result.queues.map((q) => [q.consumerName, q.processed]),
    };
  });
  expect(summary.rejected).toBe(0);
  expect(summary.completed).toBe(summary.offered);
  expect(summary.fn.kind).toBe('serverless');
  expect(summary.fn.completed).toBe(summary.offered);
  expect(summary.fn.cold).toBeGreaterThan(0);
  expect(summary.fn.throttled).toBe(0);
  expect(summary.fn.busy).toBeGreaterThan(0);
  expect(summary.kv.reads + summary.kv.writes).toBe(summary.offered);
  expect(summary.bucket.reads + summary.bucket.writes).toBe(summary.offered);
  expect(summary.topic.published).toBe(summary.offered);
  expect(summary.topic.dropped).toBe(0);
  expect(summary.listeners.sort()).toEqual([['Analytics function', summary.offered], ['Email function', summary.offered]]);

  // ---- The cards say so ------------------------------------------------------
  await expect(page.locator('.react-flow__node').filter({ hasText: 'API function' })).toContainText('runs');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Orders table' })).toContainText('writes');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Order events' })).toContainText('listeners');

  // ---- And the results sheet ---------------------------------------------------
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText(/ran \d+ invocations, \d+ of them from cold/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Components' }).nth(1).click();
  await expect(page.getByText('Serverless functions', { exact: true })).toBeVisible();
  await expect(page.getByText('Data stores', { exact: true })).toBeVisible();
  await expect(page.getByText(/key-value store · [\d,]+ reads/)).toBeVisible();
  await expect(page.getByText('one copy per listener').first()).toBeVisible();

  await page.getByRole('tab', { name: 'Cost' }).click();
  await expect(page.getByText('Lambda (x86)').first()).toBeVisible();
  await expect(page.getByText('DynamoDB, on-demand').first()).toBeVisible();
  await expect(page.getByText('S3 Standard').first()).toBeVisible();
  await expect(page.getByText('SNS standard topic').first()).toBeVisible();
  await expect(page.getByText('Metered compute time').first()).toBeVisible();
  await expect(page.getByText('Metered writes').first()).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the read-replica template takes the reads off the primary and applies every write', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Read replicas: take the reads off the primary').click();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const summary = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    const primary = result.stations.find((s) => s.kind === 'database')!;
    const replicas = result.stations.filter((s) => s.kind === 'readReplica');
    return {
      primary: { reads: primary.reads ?? 0, writes: primary.writes ?? 0 },
      replicas: replicas.map((r) => ({ reads: r.reads ?? 0, applied: r.applied ?? 0 })),
      queries: result.databaseQueries,
    };
  });
  expect(summary.primary.reads).toBe(0);
  expect(summary.replicas).toHaveLength(2);
  for (const replica of summary.replicas) {
    expect(replica.reads).toBeGreaterThan(0);
    expect(replica.applied).toBe(summary.primary.writes);
  }
  expect(summary.replicas[0]!.reads + summary.replicas[1]!.reads + summary.primary.writes).toBe(summary.queries);

  await expect(page.locator('.react-flow__node').filter({ hasText: 'Replica 1' })).toContainText('writes applied');

  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText(/answered \d+ reads and applied \d+ writes/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Cost' }).click();
  // The primary and both replicas, each priced as the same instance with a
  // full copy of the data: a compute line and a storage line apiece.
  await expect(page.getByText('RDS PostgreSQL db.m7g.large, single AZ')).toHaveCount(6);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
