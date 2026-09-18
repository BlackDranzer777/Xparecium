import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(pageErrors.get(page) ?? []).toEqual([]); });

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
});

test('missing catalogs show unpriced components and simulation still works', async ({ page }) => {
  await page.evaluate(() => window.aparecium!.store.setState({ cloudCatalog: null }));
  await page.evaluate(async () => { await window.aparecium!.store.getState().run(); });
  await page.getByRole('button', { name: 'Expand results' }).click();
  await page.getByRole('tab', { name: 'Cost' }).click();
  await expect(page.getByText('Unpriced', { exact: true }).first()).toBeVisible();
  const counts = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.cost);
  expect(counts.pricedLineCount).toBe(0);
  expect(counts.unpricedLineCount).toBe(2);
});

test('the starter result remains readable in both themes', async ({ page }, testInfo) => {
  await page.evaluate(async () => { await window.aparecium!.store.getState().run(); });
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText('Offered', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('aparecium-light.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await expect(page.getByRole('button', { name: 'Users', exact: true })).toHaveCSS('background-color', 'rgb(20, 23, 31)');
  await page.screenshot({ path: testInfo.outputPath('aparecium-dark.png'), animations: 'disabled' });
});

test('failed saves retain the current project for export', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const store = window.aparecium!.store;
    const id = store.getState().project!.id;
    store.setState({ storageOk: false });
    store.getState().renameProject('Unsaved work');
    await store.getState().createProject('empty', 'Must not replace');
    return { retained: store.getState().project!.id === id, name: store.getState().project!.name,
      status: store.getState().saveStatus };
  });
  expect(outcome).toEqual({ retained: true, name: 'Unsaved work', status: 'error' });
});

test('deleting a project with a pending edit does not resurrect it', async ({ page }) => {
  const id = await page.evaluate(async () => {
    const state = window.aparecium!.store.getState();
    const id = state.project!.id;
    state.renameProject('Delete this');
    await state.removeProject(id);
    return id;
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  expect(await page.evaluate((id) => window.aparecium!.store.getState().projects.some((p) => p.id === id), id)).toBe(false);
});

test('switching projects flushes the pending edit', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const store = window.aparecium!.store;
    const id = store.getState().project!.id;
    store.getState().renameProject('Saved before switching');
    await store.getState().createProject('empty', 'Second');
    await store.getState().openProject(id);
    return store.getState().project!.name;
  });
  expect(result).toBe('Saved before switching');
});

test('stale results remain stale after reopening and importing', async ({ page }) => {
  // This test is about results staying marked as stale. A running simulation
  // clears that state by re-running, so it has to be stopped for there to be
  // anything to observe — and stopped *after* the run, because pressing Run is
  // what starts it. The state is stored, so it survives the reload.
  await page.evaluate(async () => { await window.aparecium!.store.getState().run(); });
  await page.evaluate(() => { window.aparecium!.store.getState().stopSimulation(); });
  await page.evaluate(() => { window.aparecium!.store.getState().setWorkload({ seed: 888 }); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  await page.reload();
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const state = window.aparecium!.store.getState();
    await state.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1,
      exportedAt: '', appVersion: '0.1.0', project: state.project, runs: state.runs }));
  });
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeVisible();
});

test('imported run IDs cannot take history away from the original project', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const store = window.aparecium!.store;
    await store.getState().run();
    const original = store.getState();
    const id = original.project!.id;
    const runId = original.latestRun!.id;
    await original.importFile(JSON.stringify({ kind: 'aparecium.project', formatVersion: 1,
      exportedAt: '', appVersion: '0.1.0', project: original.project, runs: original.runs }));
    const importedId = store.getState().latestRun!.id;
    await store.getState().openProject(id);
    return { runId, importedId, restoredIds: store.getState().runs.map((r) => r.id) };
  });
  expect(outcome.importedId).not.toBe(outcome.runId);
  expect(outcome.restoredIds).toContain(outcome.runId);
});

test('editing during a run keeps the completed snapshot marked stale', async ({ page }) => {
  const stale = await page.evaluate(async () => {
    const store = window.aparecium!.store;
    const pending = store.getState().run();
    store.getState().setWorkload({ seed: 999 });
    await pending;
    return store.getState().resultsStale;
  });
  expect(stale).toBe(true);
});

test('switching projects during a run cannot attach its results to the new project', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const store = window.aparecium!.store;
    store.getState().setWorkload({ durationSeconds: 20000 });
    const pending = store.getState().run();
    await store.getState().createProject('empty', 'New project');
    store.getState().cancelRun();
    await pending;
    return { latest: store.getState().latestRun?.projectId ?? null,
      count: store.getState().runs.length, running: store.getState().running };
  });
  expect(outcome).toEqual({ latest: null, count: 0, running: false });
});
