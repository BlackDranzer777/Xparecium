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
  // The ground changes with the theme; the pastel component cards deliberately
  // do not, so the check is on the page, not on a tile.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(30, 28, 26)');
  await expect(page.getByRole('button', { name: 'Users', exact: true })).toHaveCSS('background-color', 'rgb(255, 216, 77)');
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

// Codex regressions: what comes back out of IndexedDB is not run through the
// schema, so the two checks below are made against the real store.
type StoredRecord = { id: string; name: string; updatedAt: number; document: { schemaVersion: number; nodes: { kind: string; settings: Record<string, unknown> }[] } };

/** Read one saved project record and write back whatever `patch` makes of it. */
async function rewriteProjectRecord(page: Page, id: string, patch: string) {
  await page.evaluate(async ({ id, patch }) => {
    // The patch arrives as source because a function cannot cross into the page.
    const apply = new Function('record', patch) as (record: unknown) => void;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('aparecium');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('projects', 'readwrite');
        const store = tx.objectStore('projects');
        const read = store.get(id);
        read.onsuccess = () => { const record = structuredClone(read.result); apply(record); store.put(record); };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, { id, patch });
}

async function readProjectRecord(page: Page, id: string) {
  return page.evaluate(async (id) => new Promise<StoredRecord | undefined>((resolve, reject) => {
    const request = indexedDB.open('aparecium');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('projects', 'readonly');
      const read = tx.objectStore('projects').get(id);
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), id);
}

test('a queue saved before it had failure and retry settings reopens with the defaults filled in', async ({ page }) => {
  await page.evaluate(async () => { await window.aparecium!.store.getState().createProject('async-write', 'Older queue'); });
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  const id = await page.evaluate(() => window.aparecium!.store.getState().project!.id);
  // The shape an older build saved: version 5, and a queue with no retry settings.
  await rewriteProjectRecord(page, id, `
    record.document.schemaVersion = 5;
    for (const node of record.document.nodes) {
      if (node.kind !== 'queue') continue;
      delete node.settings.processingFailureShare;
      delete node.settings.maxAttempts;
      delete node.settings.retryDelayMs;
    }`);
  const seeded = await readProjectRecord(page, id);
  expect(seeded?.document.schemaVersion).toBe(5);
  expect(seeded?.document.nodes.find((n) => n.kind === 'queue')?.settings).not.toHaveProperty('maxAttempts');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  const queue = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    const node = state.project!.document.nodes.find((n) => n.kind === 'queue')!;
    if (node.kind !== 'queue') throw new Error('not a queue');
    state.select({ type: 'node', id: node.id });
    return { version: state.project!.document.schemaVersion, name: state.project!.name, settings: node.settings };
  });
  expect(queue.name).toBe('Older queue');
  expect(queue.version).toBe(6);
  expect(queue.settings).toMatchObject({ processingFailureShare: 0, maxAttempts: 3, retryDelayMs: 100 });
  await expect(page.getByLabel('Worker failure share (0–1)')).toHaveValue('0');
  await expect(page.getByLabel('Maximum attempts per job')).toHaveValue('3');
  await expect(page.getByLabel('Wait between attempts')).toHaveValue('100');
});

test('a project saved by a newer build is refused, left as it is, and does not replace the open one', async ({ page }) => {
  const original = await page.evaluate(() => window.aparecium!.store.getState().project!.id);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().saveStatus)).toBe('saved');
  // A second, more recent record stamped with a schema version this build has never seen.
  await rewriteProjectRecord(page, original, `
    record.id = 'proj_future';
    record.name = 'From the future';
    record.updatedAt = Date.now() + 1000000;
    record.document.schemaVersion = 999;`);
  expect((await readProjectRecord(page, 'proj_future'))?.document.schemaVersion).toBe(999);

  // On reload the newest project is the unreadable one: it is refused with a
  // reason, the next readable project opens, and the record is untouched.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await expect(page.getByText(/"From the future" was not opened\. .*schema version 999/)).toBeVisible();
  expect(await page.evaluate(() => window.aparecium!.store.getState().project!.id)).toBe(original);
  expect((await readProjectRecord(page, 'proj_future'))?.document.schemaVersion).toBe(999);
  expect(await page.evaluate(() => window.aparecium!.store.getState().projects.map((p) => p.id))).toContain('proj_future');

  // Opening it on purpose gets the same answer and keeps the current project open.
  await page.evaluate(() => window.aparecium!.store.getState().renameProject('Still here'));
  await page.evaluate(async () => { await window.aparecium!.store.getState().openProject('proj_future'); });
  const after = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    return { id: state.project!.id, name: state.project!.name, toasts: state.toasts.map((t) => t.message) };
  });
  expect(after.id).toBe(original);
  expect(after.name).toBe('Still here');
  expect(after.toasts.some((m) => m.includes('schema version 999'))).toBe(true);
  expect((await readProjectRecord(page, 'proj_future'))?.document.schemaVersion).toBe(999);
});
