import { expect, test } from '@playwright/test';
import { JOB_KINDS, JOB_SERVICES } from '../src/domain/job-services';
import { SUPPORT_KINDS, SUPPORT_SERVICES } from '../src/domain/support-services';

test('background workshop settings, retries and saved result history', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.getByText('Background jobs workshop', { exact: true }).click();
  for (const kind of JOB_KINDS) {
    await page.evaluate(id => window.aparecium!.store.getState().select({ type: 'node', id }), kind);
    for (const field of Object.values(JOB_SERVICES[kind].fields)) await expect(page.getByLabel(field.label)).toBeAttached();
  }
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'queue' }));
  await page.getByLabel('Failed processing share (0–1)').fill('1'); await page.getByLabel('Failed processing share (0–1)').blur();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.jobServices?.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.queues.find(q => q.nodeId === 'queue')?.retries)).toBeGreaterThan(0);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.keepLatestRun(); s.stopSimulation(); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.jobServices?.length)).toBe(3);
  await page.getByRole('button', { name: 'Expand results' }).click(); await page.getByRole('tab', { name: 'Components', exact: true }).last().click();
  await expect(page.getByText('Background jobs', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('shared workshop exposes every setting and preserves edits through recalculation, undo, reopen and import', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.getByText('Shared services workshop', { exact: true }).click();
  for (const kind of SUPPORT_KINDS) {
    await page.evaluate(id => window.aparecium!.store.getState().select({ type: 'node', id }), kind);
    for (const field of Object.values(SUPPORT_SERVICES[kind].fields)) await expect(page.getByLabel(field.label)).toBeAttached();
  }
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.supportServices?.length)).toBe(8);
  const oldId = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.id);
  await page.evaluate(() => window.aparecium!.store.getState().select({ type: 'node', id: 'rateLimiter' }));
  await page.getByLabel('Tokens added per second').fill('5'); await page.getByLabel('Tokens added per second').blur();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.id)).not.toBe(oldId);
  const rate = () => page.evaluate(() => { const n = window.aparecium!.store.getState().project?.document.nodes.find(n => n.id === 'rateLimiter'); return n?.kind === 'rateLimiter' ? n.settings.ratePerSecond : -1; });
  await page.evaluate(() => window.aparecium!.store.getState().undo()); await expect.poll(rate).toBe(1000);
  await page.evaluate(() => window.aparecium!.store.getState().redo()); await expect.poll(rate).toBe(5);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(false);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.keepLatestRun(); s.stopSimulation(); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload(); await expect.poll(rate).toBe(5);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().latestRun?.result.supportServices?.length)).toBe(8);
  const before = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.supportServices);
  await page.evaluate(async () => { const s = window.aparecium!.store.getState(); await s.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1, exportedAt: '', appVersion: '0.1.0', project: s.project, runs: s.runs })); });
  await expect.poll(rate).toBe(5); expect(await page.evaluate(() => window.aparecium!.store.getState().latestRun!.result.supportServices)).toEqual(before);
  await page.getByRole('button', { name: 'Expand results' }).click(); await page.getByRole('tab', { name: 'Components', exact: true }).last().click();
  await expect(page.getByText('Shared services and real-time traffic', { exact: true })).toBeVisible(); expect(errors).toEqual([]);
});

test('all new messaging and shared services can be placed from the palette', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  for (const kind of [...JOB_KINDS, ...SUPPORT_KINDS]) {
    await page.getByRole('tab', { name: 'Components', exact: true }).first().click();
    const label = kind in JOB_SERVICES ? JOB_SERVICES[kind as keyof typeof JOB_SERVICES].label : SUPPORT_SERVICES[kind as keyof typeof SUPPORT_SERVICES].label;
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect.poll(() => page.evaluate(kind => window.aparecium!.store.getState().project!.document.nodes.some(n => n.kind === kind), kind)).toBe(true);
  }
});
