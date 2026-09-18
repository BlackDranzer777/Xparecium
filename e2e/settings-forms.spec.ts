import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * Every component's settings form, in a real browser.
 *
 * The engine tests prove each setting changes a run. This proves a person can
 * reach each one: the form for every kind shows every field it is supposed
 * to, and typing into one writes the number into the document.
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

/** Add a component of this kind, select it, and open its Advanced section. */
async function openForm(page: Page, kind: string): Promise<string> {
  const id = await page.evaluate((k) => {
    const store = window.aparecium!.store;
    store.getState().addComponent(k as never);
    const nodes = store.getState().project!.document.nodes;
    const node = nodes[nodes.length - 1]!;
    store.getState().select({ type: 'node', id: node.id });
    return node.id;
  }, kind);
  const advanced = page.getByRole('button', { name: /^Advanced/ });
  if (await advanced.count()) await advanced.first().click();
  return id;
}

async function settingsOf(page: Page, id: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    (nodeId) =>
      window.aparecium!.store.getState().project!.document.nodes.find((n) => n.id === nodeId)!
        .settings as unknown as Record<string, unknown>,
    id,
  );
}

interface Form {
  kind: string;
  labels: string[];
  /** One field to type into, and the setting and value it must produce. */
  edit: { label: string; type: string; setting: string; expected: unknown };
}

const FORMS: Form[] = [
  {
    kind: 'client',
    labels: ['How users decide when to send the next request', 'Active users', 'Actions per user', 'Set the request rate directly', 'Request payload', 'Response payload'],
    edit: { label: 'Active users', type: '350', setting: 'activeUsers', expected: 350 },
  },
  {
    kind: 'loadBalancer',
    labels: ['How it picks a server', 'Average time to forward a request', 'Maximum concurrent requests', 'Waiting queue limit'],
    edit: { label: 'Average time to forward a request', type: '3', setting: 'serviceTimeMs', expected: 3 },
  },
  {
    kind: 'server',
    labels: ['Resource profile', 'CPU slots', 'Memory capacity', 'CPU work per request', 'Application concurrency limit', 'Baseline memory', 'Memory per admitted request', 'Memory per queued request', 'Waiting queue limit'],
    edit: { label: 'CPU work per request', type: '12', setting: 'cpuMsPerRequest', expected: 12 },
  },
  {
    kind: 'database',
    labels: ['Stored data', 'Queries that only read', 'Average query service time', 'Maximum concurrent queries', 'Waiting queue limit', 'Query request size', 'Query result size'],
    edit: { label: 'Queries that only read', type: '70', setting: 'readShare', expected: 0.7 },
  },
  {
    kind: 'cache',
    labels: ['Assumed hit rate', 'Average lookup service time', 'Capacity', 'Maximum concurrent lookups', 'Waiting queue limit', 'Write the value back to the cache after a miss', 'Cache write service time', 'Lookup request size', 'Lookup result size', 'Cache write size'],
    edit: { label: 'Assumed hit rate', type: '65', setting: 'hitRate', expected: 0.65 },
  },
  {
    kind: 'queue',
    labels: ['Maximum depth', 'Publish service time', 'Message size', 'Concurrent publishes', 'Publish waiting limit'],
    edit: { label: 'Maximum depth', type: '777', setting: 'maxDepth', expected: 777 },
  },
  {
    kind: 'dns',
    labels: ['Requests that need a lookup', 'Average lookup time', 'Maximum concurrent lookups', 'Waiting queue limit', 'Query size', 'Answer size'],
    edit: { label: 'Requests that need a lookup', type: '5', setting: 'lookupShare', expected: 0.05 },
  },
  {
    kind: 'cdn',
    labels: ['Assumed hit rate', 'Average service time', 'Maximum concurrent requests', 'Waiting queue limit'],
    edit: { label: 'Assumed hit rate', type: '90', setting: 'hitRate', expected: 0.9 },
  },
  {
    kind: 'waf',
    labels: ['Requests blocked', 'Average inspection time', 'Maximum concurrent requests', 'Waiting queue limit'],
    edit: { label: 'Requests blocked', type: '2.5', setting: 'blockRate', expected: 0.025 },
  },
  {
    kind: 'apiGateway',
    labels: ['Enforce a rate limit', 'Average service time', 'Maximum concurrent requests', 'Waiting queue limit'],
    edit: { label: 'Average service time', type: '4', setting: 'serviceTimeMs', expected: 4 },
  },
  {
    kind: 'serverless',
    labels: ['CPU work per invocation', 'Memory per invocation', 'Concurrency limit', 'Invocations that start cold', 'Cold start time'],
    edit: { label: 'Memory per invocation', type: '1024', setting: 'memoryMb', expected: 1024 },
  },
  {
    kind: 'readReplica',
    labels: ['Average read service time', 'Time to apply one write', 'Maximum concurrent queries', 'Waiting queue limit'],
    edit: { label: 'Time to apply one write', type: '7', setting: 'applyServiceTimeMs', expected: 7 },
  },
  {
    kind: 'kvStore',
    labels: ['Operations that read', 'Average read service time', 'Average write service time', 'Stored data', 'Maximum concurrent requests', 'Waiting queue limit', 'Record size'],
    edit: { label: 'Operations that read', type: '60', setting: 'readShare', expected: 0.6 },
  },
  {
    kind: 'objectStorage',
    labels: ['Operations that write', 'Object size', 'Stored data', 'Average read time', 'Average write time', 'Maximum concurrent requests', 'Waiting queue limit'],
    edit: { label: 'Operations that write', type: '25', setting: 'writeShare', expected: 0.25 },
  },
  {
    kind: 'pubsub',
    labels: ['Backlog per listener', 'Publish service time', 'Message size', 'Concurrent publishes', 'Publish waiting limit'],
    edit: { label: 'Backlog per listener', type: '999', setting: 'maxDepth', expected: 999 },
  },
];

test('every component shows every setting, and each one writes through', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Empty canvas').click();

  for (const form of FORMS) {
    const id = await openForm(page, form.kind);
    for (const label of form.labels) {
      // Labels carry their unit in a span ("Capacity (GB)"), so match by prefix;
      // a segmented control names itself through aria-label instead of text.
      const shown = page.getByText(label).or(page.getByLabel(label)).first();
      await expect(shown, `${form.kind}: ${label}`).toBeVisible();
    }
    const field = page.getByLabel(form.edit.label);
    await field.fill(form.edit.type);
    await field.press('Enter');
    await expect
      .poll(async () => (await settingsOf(page, id))[form.edit.setting], { message: `${form.kind}.${form.edit.setting}` })
      .toBeCloseTo(form.edit.expected as number, 6);
  }

  // The two toggles that reveal or hide fields.
  const gateway = await openForm(page, 'apiGateway');
  await expect(page.getByLabel('Requests let through')).toBeHidden();
  await page.getByLabel('Enforce a rate limit').check();
  await expect(page.getByLabel('Requests let through')).toBeVisible();
  await expect(page.getByLabel('Burst allowance')).toBeVisible();
  expect((await settingsOf(page, gateway)).rateLimitPerSecond).toBe(1000);
  await page.getByLabel('Enforce a rate limit').uncheck();
  expect((await settingsOf(page, gateway)).rateLimitPerSecond).toBeNull();

  const users = await openForm(page, 'client');
  await page.getByLabel('Set the request rate directly').check();
  await expect(page.getByLabel(/^Request rate/)).toBeVisible();
  expect((await settingsOf(page, users)).requestRateOverridePerSecond).not.toBeNull();

  const cacheId = await openForm(page, 'cache');
  await page.getByLabel('Write the value back to the cache after a miss').uncheck();
  expect((await settingsOf(page, cacheId)).populateOnMiss).toBe(false);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a connection shows its two settings, and each one writes through', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  const edgeId = await page.evaluate(() => {
    const store = window.aparecium!.store;
    const edge = store.getState().project!.document.edges[0]!;
    store.getState().select({ type: 'edge', id: edge.id });
    return edge.id;
  });
  await expect(page.getByText('One-way propagation delay').first()).toBeVisible();
  await expect(page.getByText('Bandwidth').first()).toBeVisible();
  const delay = page.getByLabel('One-way propagation delay');
  await delay.fill('17');
  await delay.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(
        (id) => window.aparecium!.store.getState().project!.document.edges.find((e) => e.id === id)!.settings.propagationDelayMs,
        edgeId,
      ),
    )
    .toBe(17);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
