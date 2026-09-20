import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

/**
 * The primary browser workflow, end to end, against the production build:
 * open Xparecium, run the starter example, change something, compare, break
 * the design and see it explained, then cancel a long run.
 *
 * Console errors fail the test. Acceptance check 17 asks for the starter
 * workflow to work in a real browser without console errors, so this is the
 * check for it rather than a comment claiming it is true.
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Start from a clean browser profile so the starter project is created. */
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

test('the starter example runs, compares, validates and cancels', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  // ---- The app identifies itself -----------------------------------------
  await expect(page).toHaveTitle(/Xparecium/);
  await expect(page.getByText('Xparecium', { exact: true })).toBeVisible();

  // ---- The starter design is present and runnable -------------------------
  await expect(page.getByText('Users', { exact: true }).first()).toBeVisible();
  await expect(
    page.locator('.react-flow__node').filter({ hasText: 'Application Server' }),
  ).toBeVisible();
  await expect(page.getByText('Primary database')).toBeVisible();
  await expect(page.getByText('per month')).toBeHidden();

  // ---- Run --------------------------------------------------------------
  await page.getByRole('button', { name: 'Run simulation' }).click();
  // The sheet opens collapsed: the headline strip is the confirmation.
  await expect(page.getByText('per month')).toBeVisible();
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText('Offered', { exact: true })).toBeVisible();

  const summary = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    const result = state.latestRun!.result;
    return {
      status: result.status,
      offered: result.offered,
      completed: result.completed,
      rejected: result.rejected,
      meanMs: result.responseTime.meanMs,
      dbQueries: result.databaseQueries,
      cost: state.latestRun!.cost.totalMonthly,
      stale: state.resultsStale,
    };
  });

  expect(summary.status).toBe('completed');
  expect(summary.offered).toBe(1334);
  expect(summary.completed).toBe(1334);
  expect(summary.rejected).toBe(0);
  expect(summary.dbQueries).toBe(1334);
  expect(summary.stale).toBe(false);
  // The starter path is uncontended, so the response time is the sum of its
  // fixed parts: 12.048 + 4 + 0.404096 + 6 + 0.465536 + 4 + 12.96
  expect(summary.meanMs).toBeCloseTo(39.877632, 6);
  expect(Number(summary.cost)).toBeGreaterThan(0);

  // ---- The cost tab explains itself --------------------------------------
  // The starter runs on AWS, whose rates are read from AWS's own price list,
  // so the tab says they are verified and does not warn about placeholders.
  await page.getByRole('tab', { name: 'Cost' }).click();
  await expect(page.getByText('Estimated monthly cost')).toBeVisible();
  await expect(page.getByText('Verified rates')).toBeVisible();
  await expect(page.getByText('Illustrative rates')).toBeHidden();
  await expect(
    page.getByText(/illustrative placeholder rates, not quoted provider prices/),
  ).toBeHidden();
  await expect(page.getByText(/verified \d{4}-\d{2}-\d{2}/).first()).toBeVisible();

  // ---- The running simulation follows an edit, unasked --------------------
  await page.locator('.react-flow__node').filter({ hasText: 'Application Server' }).click();
  await expect(page.getByLabel('Resource profile')).toBeVisible();
  await page.getByLabel('Resource profile').selectOption('large');

  // No second press of Run: the simulation is running, so it picks the change
  // up by itself and the results catch up with the canvas.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const server = window.aparecium!.store
          .getState()
          .latestRun!.inputDocument.nodes.find((n) => n.kind === 'server') as
          | { settings: { cpuSlots: number } }
          | undefined;
        return server?.settings.cpuSlots ?? null;
      }),
    )
    .toBe(4);
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeHidden();

  // ---- Compare -----------------------------------------------------------

  // The sheet is still open on the Cost tab from earlier, so the next click is
  // what brings the comparison into view.
  await page.getByRole('tab', { name: 'Compare' }).click();
  await expect(page.getByText('What changed in the inputs')).toBeVisible();
  await expect(page.getByText('Application Server: cpuSlots')).toBeVisible();

  // ---- A previous run keeps its own inputs -------------------------------
  const history = await page.evaluate(() => {
    const runs = window.aparecium!.store.getState().runs;
    return runs.map((run) => ({
      cpuSlots: (run.inputDocument.nodes.find((n) => n.kind === 'server') as
        | { settings: { cpuSlots: number } }
        | undefined)?.settings.cpuSlots,
    }));
  });
  expect(history[0]?.cpuSlots).toBe(4);
  expect(history[1]?.cpuSlots).toBe(2);

  // ---- An unsupported design is explained, not silently run ---------------
  // Both the side panel and the results sheet have a 'Components' tab, so the
  // click has to say which tablist it means.
  await page
    .getByRole('tablist', { name: 'Side panel' })
    .getByRole('tab', { name: 'Components' })
    .click();
  await page.getByRole('button', { name: 'Users', exact: true }).click();

  await page.getByRole('button', { name: /problem/ }).click();
  await expect(page.getByText(/is not connected to anything/)).toBeVisible();
  await expect(
    page.getByText(
      'Drag a connection from the users to a Load Balancer or an Application Server.',
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

  // ---- Stopping a long run is responsive ---------------------------------
  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  await page.getByLabel('Run duration in seconds').fill('20000');
  await page.getByLabel('Run duration in seconds').blur();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled({
    timeout: 10_000,
  });

  const cancelled = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    return {
      status: result.status,
      offered: result.offered,
      simulatedMs: result.simulatedMs,
    };
  });
  expect(cancelled.status).toBe('cancelled');
  // It stopped well before the configured 20,000 second window.
  expect(cancelled.simulatedMs).toBeLessThan(20_000_000);
  expect(cancelled.offered).toBeGreaterThan(0);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a project survives export and re-import', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  const exported = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    return JSON.stringify({
      kind: 'aparecium.project',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      project: state.project,
      runs: [],
    });
  });

  await page.evaluate(async (text) => {
    await window.aparecium!.store.getState().importFile(text);
  }, exported);

  await expect(page.getByText(/\(imported\)/).first()).toBeVisible();

  const after = await page.evaluate(() => {
    const state = window.aparecium!.store.getState();
    return {
      name: state.project!.name,
      nodes: state.project!.document.nodes.length,
      edges: state.project!.document.edges.length,
      projects: state.projects.length,
    };
  });
  expect(after.name).toContain('(imported)');
  expect(after.nodes).toBe(3);
  expect(after.edges).toBe(2);
  // The original project is still there: import never overwrites.
  expect(after.projects).toBeGreaterThanOrEqual(2);

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(page.getByText('Offered', { exact: true })).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('rejects an import that is not an Xparecium export', async ({ page }) => {
  await openFresh(page);
  await page.evaluate(async () => {
    await window.aparecium!.store.getState().importFile(JSON.stringify({ hello: 'world' }));
  });
  await expect(page.getByText('This file is not a valid Xparecium project export.')).toBeVisible();
});

test('a superseded run is stopped and its messages are ignored', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  const outcome = await page.evaluate(async () => {
    const client = window.aparecium!.simulation;
    const base = window.aparecium!.store.getState().project!.document;
    const limits = {
      maxPendingEvents: 500_000,
      maxInFlightRequests: 200_000,
      maxProcessedEvents: 5_000_000,
      maxJourneySamples: 8,
    };

    // A long run, then immediately a short one. The second supersedes the first.
    const slow = structuredClone(base);
    slow.workload = { ...slow.workload, durationSeconds: 20_000, seed: 111 };
    const quick = structuredClone(base);
    quick.workload = { ...quick.workload, durationSeconds: 2, seed: 222 };

    let slowProgress = 0;
    let quickProgress = 0;
    const first = client.run(slow, limits, () => {
      slowProgress += 1;
    });
    const second = client.run(quick, limits, () => {
      quickProgress += 1;
    });

    const [a, b] = await Promise.all([first.result, second.result]);
    // Give any late message from the superseded run time to arrive and be dropped.
    await new Promise((resolve) => setTimeout(resolve, 300));

    return {
      firstStatus: a.status,
      firstSeed: a.seed,
      secondStatus: b.status,
      secondSeed: b.seed,
      secondOffered: b.offered,
      slowProgressAfterSupersede: slowProgress,
      quickProgress,
      differentIds: first.runId !== second.runId,
    };
  });

  // The superseded run settles rather than hanging, and it is stopped.
  expect(outcome.differentIds).toBe(true);
  expect(outcome.firstStatus).toBe('cancelled');
  expect(outcome.firstSeed).toBe(111);
  // The current run is unaffected by the one it replaced.
  expect(outcome.secondStatus).toBe('completed');
  expect(outcome.secondSeed).toBe(222);
  expect(outcome.secondOffered).toBe(134);
  // No progress from the superseded run reached its callback.
  expect(outcome.slowProgressAfterSupersede).toBe(0);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the theme starts light, can be switched, and is remembered', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('aparecium.theme'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();

  // Light is the default, and it does not depend on the operating system.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // The choice survives a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Switch to the light theme' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark');

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the side panel can be put away to give the canvas the whole screen', async ({ page }) => {
  await openFresh(page);

  const panel = page.getByRole('tablist', { name: 'Side panel' });
  await expect(panel).toBeVisible();

  await page.getByRole('button', { name: 'Hide the side panel' }).click();
  await expect(panel).toBeHidden();

  await page.getByRole('button', { name: 'Show the side panel' }).click();
  await expect(panel).toBeVisible();
});


test('a load balancer spreads traffic across a pool of servers', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);

  await page.evaluate(async () => {
    await window.aparecium!.store.getState().createProject('load-balanced', 'Balanced');
  });
  await expect(
    page.locator('.react-flow__node').filter({ hasText: 'Load balancer' }),
  ).toBeVisible();
  await expect(
    page.locator('.react-flow__node').filter({ hasText: 'Application Server 4' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const shape = await page.evaluate(() => {
    const result = window.aparecium!.store.getState().latestRun!.result;
    return {
      status: result.status,
      offered: result.offered,
      completed: result.completed,
      perServer: result.servers.map((s) => s.completed).sort((a, b) => b - a),
      balancerForwarded: result.stations.find((s) => s.kind === 'loadBalancer')?.operations,
      dbQueries: result.databaseQueries,
      clients: result.clients.length,
    };
  });

  expect(shape.status).toBe('completed');
  expect(shape.completed).toBe(shape.offered);
  // Round robin over four servers: 334, 334, 333, 333.
  expect(shape.perServer).toEqual([334, 334, 333, 333]);
  expect(shape.balancerForwarded).toBe(shape.offered);
  expect(shape.dbQueries).toBe(shape.offered);
  expect(shape.clients).toBe(1);

  // Each component carries its own result on the canvas.
  const balancerNode = page.locator('.react-flow__node').filter({ hasText: 'Load balancer' });
  await expect(balancerNode.getByText(/forwarded/)).toBeVisible();
  const serverNode = page.locator('.react-flow__node').filter({ hasText: 'Application Server 1' });
  await expect(serverNode.getByText(/served/)).toBeVisible();
  const dbNode = page.locator('.react-flow__node').filter({ hasText: 'SQL database' });
  await expect(dbNode.getByText(/queries/)).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('traffic keeps flowing while the results describe the design on screen', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByLabel('Simulation mode').selectOption('live');

  const packetOpacity = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ap-packet')].slice(0, 3).map((c) => (c as HTMLElement).style.opacity),
    );

  // Nothing flows before a run: there is no traffic to show.
  expect(await packetOpacity()).toEqual(['0', '0', '0']);

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  // Live keeps processing new requests while the packets move.
  await page.waitForTimeout(5000);
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  // Editing the design does not interrupt it. The numbers are behind the canvas
  // for as long as the re-run takes, which the results strip says; the system
  // itself is still running.
  await page.evaluate(() => {
    window.aparecium!.store.getState().setWorkload({ seed: 4242 });
  });
  expect(await packetOpacity()).toEqual(['1', '1', '1']);
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(
    false,
  );
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  // Stopping is what stops it.
  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible();
  expect(await packetOpacity()).toEqual(['0', '0', '0']);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('the run button is a running/stopped toggle', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByLabel('Simulation mode').selectOption('live');

  // Nothing has run, so there is nothing to stop.
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeHidden();

  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeHidden();

  // It stays that way: the button reflects the simulation, not the fraction of
  // a second the worker spends on one pass of it.
  await page.waitForTimeout(2000);
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeVisible();

  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible();

  // Stopped means stopped: an edit no longer re-runs.
  const before = await page.evaluate(() => window.aparecium!.store.getState().latestRun!.id);
  await page.evaluate(() => window.aparecium!.store.getState().setWorkload({ seed: 31337 }));
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.aparecium!.store.getState().latestRun!.id)).toBe(before);
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeVisible();

  // And starting it again picks the design up where it is.
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(
    false,
  );

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('a design that cannot be simulated does not stop the simulation', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await openFresh(page);
  await page.getByLabel('Simulation mode').selectOption('live');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();

  const packetOpacity = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.ap-packet')]
        .slice(0, 3)
        .map((c) => (c as HTMLElement).style.opacity),
    );
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  // A second database on one server is a hard error: the design cannot be
  // simulated until it is undone. That used to freeze the canvas silently.
  await page.evaluate(() => {
    const store = window.aparecium!.store;
    store.getState().addComponent('database');
    const document = store.getState().project!.document;
    const server = document.nodes.find((n) => n.kind === 'server')!;
    const spare = document.nodes.filter((n) => n.kind === 'database').at(-1)!;
    store.getState().connect(server.id, spare.id);
  });

  await expect(page.getByRole('button', { name: /1 problem/ })).toBeVisible();
  await page.waitForTimeout(1200);
  // Still running, still showing the last result it managed to produce.
  await expect(page.getByRole('button', { name: /Stop (simulation|updates)/ })).toBeVisible();
  expect(await packetOpacity()).toEqual(['1', '1', '1']);
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeVisible();

  // Undo the bad connection and it picks itself back up without being asked.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.aparecium!.store.getState().resultsStale)).toBe(
    false,
  );
  expect(await packetOpacity()).toEqual(['1', '1', '1']);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('changing a setting re-runs on its own, without flooding the history', async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('aparecium.live');
    return new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('aparecium');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();

  const state = () =>
    page.evaluate(() => {
      const s = window.aparecium!.store.getState();
      return {
        offered: s.latestRun?.result.offered ?? null,
        automatic: s.latestRun?.automatic ?? null,
        runs: s.runs.length,
        kept: s.runs.filter((r) => !r.automatic).length,
      };
    });

  // The simulation follows the design by default, and nothing has run yet.
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeVisible();
  expect((await state()).offered).toBeNull();

  // Edit a setting and do not press Run.
  await page.locator('.react-flow__node').filter({ hasText: 'Users' }).first().click();
  await page.getByLabel('Active users').fill('400');
  await expect.poll(async () => (await state()).offered).toBe(2667);
  expect((await state()).automatic).toBe(true);

  // A second edit replaces the first preview rather than stacking up.
  await page.getByLabel('Active users').fill('800');
  await expect.poll(async () => (await state()).offered).toBe(5334);
  const afterTwoEdits = await state();
  expect(afterTwoEdits.runs).toBe(1);
  expect(afterTwoEdits.kept).toBe(0);
  await expect(page.getByText('Preview', { exact: true })).toBeVisible();

  // Keep is what turns the result on screen into history.
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect.poll(async () => (await state()).kept).toBe(1);
  expect((await state()).automatic).toBe(false);
  await expect(page.getByText('Preview', { exact: true })).toBeHidden();

  // Stopping the simulation stops it following the design.
  await page.getByRole('button', { name: /Stop (simulation|updates)/ }).click();
  await page.getByLabel('Active users').fill('120');
  await expect(page.getByText('Earlier configuration', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand results' }).click();
  await expect(
    page.getByText('These results belong to an earlier configuration'),
  ).toBeVisible();
  await page.waitForTimeout(1200);
  expect((await state()).offered).toBe(5334);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
