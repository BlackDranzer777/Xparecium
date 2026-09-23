import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { DOCUMENT_SCHEMA_VERSION } from '../src/domain/types';

/**
 * The backend set completed in entry 075, through the interface: the Backend
 * workshop template, auto scaling on the Application Server — switched on and
 * off, tuned, run, billed and reopened — and an older saved server, which must
 * reopen with auto scaling off rather than with blank controls.
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

const appSettings = (page: Page) => page.evaluate(() => {
  const node = window.aparecium!.store.getState().project!.document.nodes.find((n) => n.id === 'app');
  if (node?.kind !== 'server') throw new Error('not a server');
  return node.settings;
});

test('the backend workshop scales, locks and runs its workflow, and the bill follows the machines', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByText('Backend workshop: locks, workflows, auto scaling', { exact: true }).click();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Order workflow' })).toContainText('3 steps · 20 ms between');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Seat lock' })).toContainText('500 locks · 15 ms held');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Checkout service' })).toContainText('2 CPU × 1–5');

  // ---- The auto-scaling panel shows what the template set -----------------
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'app' }));
  const toggle = page.getByLabel('Scale this server automatically');
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('Fewest instances')).toHaveValue('1');
  await expect(page.getByLabel('Most instances')).toHaveValue('5');
  await expect(page.getByLabel('Target CPU use (0–1)')).toHaveValue('0.6');
  await expect(page.getByLabel('Warm-up time')).toHaveValue('5');
  await expect(page.getByLabel('Check every')).toHaveValue('2');

  // ---- A run: machines added, orders finished, nothing refused -----------------
  await page.evaluate(() => window.aparecium!.store.getState().setContinuous(false));
  await runToResult(page);
  const run = await page.evaluate(() => {
    const r = window.aparecium!.store.getState().latestRun!;
    const app = r.result.servers.find((s) => s.nodeId === 'app')!;
    const workflow = r.result.jobServices!.find((j) => j.kind === 'workflow')!;
    const compute = r.cost.lines.find((l) => l.nodeId === 'app' && l.chargeType === 'compute')!;
    const transitions = r.cost.lines.find((l) => l.nodeId === 'workflow')!;
    return { rejected: r.result.rejected, scaleOuts: app.scaleOuts ?? 0, average: app.instancesAverage ?? 0,
      started: workflow.accepted, finished: workflow.completed, computeBasis: compute.basis, computeQuantity: Number(compute.quantity),
      transitionsVerified: transitions.verified, transitionsRate: transitions.rate };
  });
  expect(run.rejected).toBe(0);
  expect(run.scaleOuts).toBeGreaterThan(0);
  expect(run.average).toBeGreaterThan(1);
  expect(run.finished).toBe(run.started);
  expect(run.computeBasis).toContain('auto-scaled group of 1 to 5 instances');
  expect(run.computeQuantity).toBeCloseTo(run.average * 730, 0);
  expect(run.transitionsVerified).toBe(true);
  expect(run.transitionsRate).toBe('25.00');
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Checkout service' })).toContainText(/instances avg · peak \d/);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Order workflow' })).toContainText(/finished · [\d,]+ retries/);

  // ---- Switched off, it is one machine again; tuned, the ceiling holds -------
  await toggle.uncheck();
  await expect.poll(async () => (await appSettings(page)).autoscaleEnabled).toBe(false);
  await expect(page.getByLabel('Fewest instances')).toHaveCount(0);
  await toggle.check();
  await page.getByLabel('Most instances').fill('2');
  await page.getByLabel('Most instances').blur();
  await expect.poll(async () => (await appSettings(page)).maxInstances).toBe(2);
  await runToResult(page);
  const capped = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.servers.find((s) => s.nodeId === 'app')!.instancesPeak);
  expect(capped).toBeLessThanOrEqual(2);

  // ---- Saved, reloaded, still there ----------------------------------------------
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  // The reopened project may already be running, so wait for the app, not the button.
  await expect.poll(() => page.evaluate(() => window.aparecium?.store.getState().ready === true)).toBe(true);
  expect(await appSettings(page)).toMatchObject({ autoscaleEnabled: true, minInstances: 1, maxInstances: 2 });
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a server saved before auto scaling existed reopens with it off and its controls filled in', async ({ page }) => {
  await openFresh(page);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  const id = await page.evaluate(() => window.aparecium!.store.getState().project!.id);
  // The shape a version 6 build saved: no auto-scaling fields at all.
  await page.evaluate(async (id) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aparecium');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const read = store.get(id);
        read.onsuccess = () => {
          const record = structuredClone(read.result);
          record.document.schemaVersion = 6;
          for (const node of record.document.nodes) {
            if (node.kind !== 'server') continue;
            for (const key of ['autoscaleEnabled', 'minInstances', 'maxInstances', 'targetCpuShare', 'instanceWarmupSeconds', 'scaleCheckSeconds']) delete node.settings[key];
          }
          store.put(record);
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, id);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  const server = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    const node = state.project!.document.nodes.find((n) => n.kind === 'server')!;
    state.select({ type: 'node', id: node.id });
    return { version: state.project!.document.schemaVersion, settings: node.settings };
  });
  expect(server.version).toBe(DOCUMENT_SCHEMA_VERSION);
  expect(server.settings).toMatchObject({ autoscaleEnabled: false, minInstances: 1, maxInstances: 4 });
  await page.getByRole('button', { name: /^Auto scaling/ }).click();
  await expect(page.getByLabel('Scale this server automatically')).not.toBeChecked();
  await page.getByLabel('Scale this server automatically').check();
  await expect(page.getByLabel('Fewest instances')).toHaveValue('1');
  await expect(page.getByLabel('Most instances')).toHaveValue('4');
});
