import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';
import { DATA_SERVICES } from '../src/domain/data-services';
import { COMPONENT_LABELS, RELEASED_KINDS } from '../src/domain/defaults';
import { JOB_SERVICES } from '../src/domain/job-services';
import { SUPPORT_SERVICES } from '../src/domain/support-services';
import { CHAIN_SERVICES } from '../src/domain/chain-services';
import type { ComponentKind } from '../src/domain/types';

/**
 * One component at a time, from the staged sixteen into the app.
 *
 * Each entry below is a component that has been switched on in RELEASED_KINDS.
 * For each, a person can: find it in the palette, add it, see every setting,
 * wire it the way it is meant to be wired, run, and read its own numbers on
 * its card and in the results sheet — and on the cost sheet, where it is
 * honestly unpriced until a provider's rate is read for it. Components not
 * yet released must not appear in the palette at all.
 */

/**
 * How a kind is wired into the starter (Users -> Application Server -> Database):
 * - behindServer: the server calls it.
 * - inFront: it sits between the users and the server.
 * - source: it sends work to the server on its own (a scheduler).
 * - stream: the server publishes to it, and a second server reads from it.
 * - deadLetter: the server publishes to a queue whose worker fails every job.
 * - workflow: the server starts it, and a second server is its one step.
 * - rpc: it replaces the server as the entry point, calling a new contract.
 * - oracle: it updates a new contract of its own.
 */
type Placement = 'behindServer' | 'inFront' | 'source' | 'stream' | 'deadLetter' | 'workflow' | 'rpc' | 'oracle';

interface Release {
  kind: ComponentKind;
  placement: Placement;
  /** Every field label the settings form must show. */
  labels: string[];
  /** A numeric setting to type into, and the value it must produce. */
  edit: { label: string; type: string; setting: string; expected: number };
  /** Text the canvas card and the results row carry after a run. */
  detail: RegExp;
  /** The results sheet section the component reports under. */
  section: string;
}

/** Nothing to read for these: see entries 066 and 076. */
const UNPRICED_BY_DESIGN: ComponentKind[] = ['identity', 'rateLimiter', 'serviceMesh', 'rpcNode', 'smartContract', 'indexer', 'oracle', 'ipfs'];
/** A wallet costs the app nothing, so it has no line at all (entry 076). */
const NO_COST_LINES: ComponentKind[] = ['wallet'];

const dataLabels = (kind: keyof typeof DATA_SERVICES) => Object.values(DATA_SERVICES[kind].fields).map((f) => f.label);
const jobLabels = (kind: keyof typeof JOB_SERVICES) =>
  Object.values(JOB_SERVICES[kind].fields as Record<string, { label: string }>).map((f) => f.label);
const supportLabels = (kind: keyof typeof SUPPORT_SERVICES) => Object.values(SUPPORT_SERVICES[kind].fields).map((f) => f.label);
const chainLabels = (kind: keyof typeof CHAIN_SERVICES) => Object.values(CHAIN_SERVICES[kind].fields).map((f) => f.label);

const RELEASES: Release[] = [
  // ---- data stores (entries 062, 063) -----------------------------------------
  { kind: 'documentDb', placement: 'behindServer', labels: dataLabels('documentDb'), section: 'Specialized data stores',
    edit: { label: 'Reads using an index (0–1)', type: '0.5', setting: 'indexHitShare', expected: 0.5 }, detail: /indexed · [\d,]+ scans/ },
  { kind: 'wideColumn', placement: 'behindServer', labels: dataLabels('wideColumn'), section: 'Specialized data stores',
    edit: { label: 'Partitions', type: '8', setting: 'partitions', expected: 8 }, detail: /partitions · [\d,]+ write copies/ },
  { kind: 'searchIndex', placement: 'behindServer', labels: dataLabels('searchIndex'), section: 'Specialized data stores',
    edit: { label: 'Shards searched per query', type: '3', setting: 'shardsPerQuery', expected: 3 }, detail: /searchable · [\d,]+ refreshing/ },
  { kind: 'warehouse', placement: 'behindServer', labels: dataLabels('warehouse'), section: 'Specialized data stores',
    edit: { label: 'Data scanned per report', type: '2', setting: 'scanGbPerQuery', expected: 2 }, detail: /GB scanned/ },
  { kind: 'timeSeries', placement: 'behindServer', labels: dataLabels('timeSeries'), section: 'Specialized data stores',
    edit: { label: 'Points in each write', type: '20', setting: 'pointsPerWrite', expected: 20 }, detail: /points kept · [\d,]+ ingested/ },
  // ---- background jobs (entry 064) ---------------------------------------------
  { kind: 'eventStream', placement: 'stream', labels: jobLabels('eventStream'), section: 'Background jobs',
    edit: { label: 'Partitions', type: '2', setting: 'partitions', expected: 2 }, detail: /retained · [\d,]+ groups/ },
  { kind: 'deadLetter', placement: 'deadLetter', labels: jobLabels('deadLetter'), section: 'Background jobs',
    edit: { label: 'Maximum held jobs', type: '500', setting: 'maxDepth', expected: 500 }, detail: /received · [\d,]+ expired/ },
  { kind: 'scheduler', placement: 'source', labels: jobLabels('scheduler'), section: 'Background jobs',
    edit: { label: 'Run every', type: '2', setting: 'intervalSeconds', expected: 2 }, detail: /ticks · [\d,]+ skipped/ },
  // ---- shared services and real-time (entry 065) ------------------------------
  { kind: 'websocket', placement: 'inFront', labels: supportLabels('websocket'), section: 'Shared services and real-time traffic',
    edit: { label: 'Connection limit', type: '500', setting: 'maxConnections', expected: 500 }, detail: /connected · [\d,]+ refused/ },
  { kind: 'rateLimiter', placement: 'inFront', labels: supportLabels('rateLimiter'), section: 'Shared services and real-time traffic',
    edit: { label: 'Tokens added per second', type: '500', setting: 'ratePerSecond', expected: 500 }, detail: /passed · [\d,]+ limited/ },
  { kind: 'serviceMesh', placement: 'inFront', labels: supportLabels('serviceMesh'), section: 'Shared services and real-time traffic',
    edit: { label: 'Connection attempts', type: '2', setting: 'maxAttempts', expected: 2 }, detail: /retries · [\d,]+ circuit refused/ },
  { kind: 'identity', placement: 'behindServer', labels: supportLabels('identity'), section: 'Shared services and real-time traffic',
    edit: { label: 'Caller cache lifetime', type: '5', setting: 'cacheTtlSeconds', expected: 5 }, detail: /cached · [\d,]+ denied/ },
  { kind: 'discovery', placement: 'behindServer', labels: supportLabels('discovery'), section: 'Shared services and real-time traffic',
    edit: { label: 'Configuration update interval', type: '30', setting: 'updateSeconds', expected: 30 }, detail: /cached · [\d,]+ older version/ },
  { kind: 'secrets', placement: 'behindServer', labels: supportLabels('secrets'), section: 'Shared services and real-time traffic',
    edit: { label: 'Credential rotation interval', type: '30', setting: 'rotationSeconds', expected: 30 }, detail: /cached · [\d,]+ expired/ },
  { kind: 'notification', placement: 'behindServer', labels: supportLabels('notification'), section: 'Shared services and real-time traffic',
    edit: { label: 'Delivery attempts', type: '2', setting: 'maxAttempts', expected: 2 }, detail: /delivered · [\d,]+ retries/ },
  { kind: 'monitoring', placement: 'behindServer', labels: supportLabels('monitoring'), section: 'Shared services and real-time traffic',
    edit: { label: 'Sampled operation share (0–1)', type: '0.5', setting: 'sampleShare', expected: 0.5 }, detail: /retained · [\d,]+ dropped/ },
  // ---- completing the backend set (entry 075) ---------------------------------
  { kind: 'lock', placement: 'behindServer', labels: supportLabels('lock'), section: 'Shared services and real-time traffic',
    edit: { label: 'Separate locks', type: '10', setting: 'lockKeys', expected: 10 }, detail: /waited · [\d,]+ gave up/ },
  { kind: 'workflow', placement: 'workflow', labels: jobLabels('workflow'), section: 'Background jobs',
    edit: { label: 'Attempts per step', type: '2', setting: 'maxAttempts', expected: 2 }, detail: /finished · [\d,]+ retries/ },
  // ---- blockchain (entry 076) ---------------------------------------------------
  { kind: 'wallet', placement: 'inFront', labels: chainLabels('wallet'), section: 'Blockchain',
    edit: { label: 'Actions that need a signature (0–1)', type: '0.5', setting: 'transactionShare', expected: 0.5 }, detail: /signed · [\d,]+ refused/ },
  { kind: 'rpcNode', placement: 'rpc', labels: chainLabels('rpcNode'), section: 'Blockchain',
    edit: { label: 'Plan limit (requests per second)', type: '300', setting: 'ratePerSecond', expected: 300 }, detail: /answered/ },
  { kind: 'smartContract', placement: 'behindServer', labels: chainLabels('smartContract'), section: 'Blockchain',
    edit: { label: 'Time between blocks', type: '2', setting: 'blockSeconds', expected: 2 }, detail: /in blocks · fee ×[\d.]+/ },
  { kind: 'indexer', placement: 'behindServer', labels: chainLabels('indexer'), section: 'Blockchain',
    edit: { label: 'Query time', type: '8', setting: 'serviceTimeMs', expected: 8 }, detail: /queries · [\d.]+ s lag/ },
  { kind: 'oracle', placement: 'oracle', labels: chainLabels('oracle'), section: 'Blockchain',
    edit: { label: 'Update every', type: '5', setting: 'heartbeatSeconds', expected: 5 }, detail: /updates · [\d.]+ s oldest/ },
  { kind: 'ipfs', placement: 'behindServer', labels: chainLabels('ipfs'), section: 'Blockchain',
    edit: { label: 'Reads the gateway has cached (0–1)', type: '0.5', setting: 'gatewayHitShare', expected: 0.5 }, detail: /cached · [\d,]+ uncached/ },
];

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

/** Wire the freshly added component into the starter, in the page. */
async function wire(page: Page, kind: ComponentKind, placement: Placement): Promise<string> {
  return page.evaluate(
    ([k, p]) => {
      const store = window.aparecium!.store;
      const state = () => store.getState();
      const nodes = () => state().project!.document.nodes;
      const node = nodes().find((n) => n.kind === k)!;
      const server = nodes().find((n) => n.kind === 'server')!;
      const users = nodes().find((n) => n.kind === 'client')!;
      const lastAdded = () => nodes()[nodes().length - 1]!;
      switch (p) {
        case 'behindServer':
          state().connect(server.id, node.id);
          break;
        case 'inFront': {
          const link = state().project!.document.edges.find((e) => e.source === users.id && e.target === server.id)!;
          state().deleteEdge(link.id);
          state().connect(users.id, node.id);
          state().connect(node.id, server.id);
          break;
        }
        case 'source':
          state().connect(node.id, server.id);
          break;
        case 'stream': {
          state().addComponent('server');
          const reader = lastAdded();
          state().connect(server.id, node.id);
          state().connect(node.id, reader.id);
          break;
        }
        case 'rpc': {
          // The RPC node is the entry point; the starter's server and database go.
          const database = nodes().find((n) => n.kind === 'database')!;
          state().deleteNode(server.id);
          state().deleteNode(database.id);
          state().addComponent('smartContract');
          const contract = lastAdded();
          state().connect(users.id, node.id);
          state().connect(node.id, contract.id);
          break;
        }
        case 'oracle': {
          state().addComponent('smartContract');
          const contract = lastAdded();
          state().connect(server.id, contract.id);
          state().connect(node.id, contract.id);
          break;
        }
        case 'workflow': {
          state().addComponent('server');
          const step = lastAdded();
          state().connect(server.id, node.id);
          state().connect(node.id, step.id);
          break;
        }
        case 'deadLetter': {
          state().addComponent('queue');
          const queue = lastAdded();
          state().addComponent('server');
          const worker = lastAdded();
          state().connect(server.id, queue.id);
          state().connect(queue.id, worker.id);
          state().connect(queue.id, node.id);
          // Every job fails at the worker, so the dead-letter queue receives them.
          state().mutate((draft) => {
            const q = draft.nodes.find((n) => n.id === queue.id);
            if (q && q.kind === 'queue') q.settings.processingFailureShare = 1;
          });
          break;
        }
      }
      state().select({ type: 'node', id: node.id });
      return node.id;
    },
    [kind, placement] as const,
  );
}

test('unreleased components are not offered in the palette', async ({ page }) => {
  await openFresh(page);
  const offered = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? ''),
  );
  const allKinds = Object.keys(COMPONENT_LABELS) as ComponentKind[];
  for (const kind of allKinds) {
    const label = COMPONENT_LABELS[kind];
    const shown = offered.some((text) => text === label);
    expect(shown, `${kind} (${label}) ${RELEASED_KINDS.includes(kind) ? 'should' : 'must not'} be in the palette`)
      .toBe(RELEASED_KINDS.includes(kind));
  }
  // A workshop template is offered only once every component in it is released.
  for (const [template, kinds] of [
    ['Data workshop', ['documentDb', 'wideColumn', 'searchIndex', 'warehouse', 'timeSeries']],
    ['Background jobs workshop', ['scheduler', 'deadLetter', 'eventStream']],
    ['Shared services workshop', ['websocket', 'rateLimiter', 'serviceMesh', 'identity', 'discovery', 'secrets', 'notification', 'monitoring']],
    ['Backend workshop: locks, workflows, auto scaling', ['lock', 'workflow']],
    ['Blockchain workshop: an NFT drop', ['wallet', 'rpcNode', 'smartContract', 'indexer', 'oracle', 'ipfs']],
  ] as const) {
    const released = kinds.every((k) => RELEASED_KINDS.includes(k));
    await expect(page.getByText(template, { exact: true })).toHaveCount(released ? 1 : 0);
  }
});

for (const release of RELEASES) {
  test(`${COMPONENT_LABELS[release.kind]}: added, configured, wired, run, read and priced honestly`, async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await openFresh(page);
    expect(RELEASED_KINDS).toContain(release.kind);

    // ---- From the palette, wired the way it is meant to be -----------------
    await page.getByRole('button', { name: COMPONENT_LABELS[release.kind], exact: true }).click();
    const id = await wire(page, release.kind, release.placement);
    await expect(page.getByRole('button', { name: /problem/ })).toBeHidden();

    // ---- Every setting is on screen, and one writes through -----------------
    const advanced = page.getByRole('button', { name: /^Advanced/ });
    if (await advanced.count()) await advanced.first().click();
    // A label carries its unit after it ("Record size(bytes)"), so match by prefix.
    for (const label of release.labels) {
      await expect(page.getByLabel(label).first(), `${release.kind}: ${label}`).toBeAttached();
    }
    const field = page.getByLabel(release.edit.label).first();
    await field.fill(release.edit.type);
    await field.blur();
    await expect
      .poll(() =>
        page.evaluate(
          ([nodeId, setting]) =>
            (window.aparecium!.store.getState().project!.document.nodes.find((n) => n.id === nodeId)!
              .settings as unknown as Record<string, number>)[setting!],
          [id, release.edit.setting] as const,
        ),
      )
      .toBeCloseTo(release.edit.expected, 6);

    // ---- Run, and the component did work -------------------------------------
    // Live is the default, so an edit already schedules a run; click only if
    // the app is still offering to start one, then wait for a fresh result.
    const runButton = page.getByRole('button', { name: 'Run simulation' });
    if (await runButton.isVisible()) await runButton.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = window.aparecium!.store.getState();
          return s.latestRun !== null && !s.resultsStale && !s.running;
        }),
      )
      .toBe(true);
    // An unpriced component makes the estimate partial, and the bar says so;
    // a priced one leaves it whole.
    await expect(page.getByText(/partial monthly estimate|per month/).first()).toBeVisible();
    const summary = await page.evaluate((nodeId) => {
      const result = window.aparecium!.store.getState().latestRun!.result;
      const own =
        (result.dataServices ?? []).find((s) => s.nodeId === nodeId) ??
        (result.jobServices ?? []).find((s) => s.nodeId === nodeId) ??
        (result.supportServices ?? []).find((s) => s.nodeId === nodeId) ??
        (result.chainServices ?? []).find((s) => s.nodeId === nodeId);
      // An RPC node reports with the servers, as the compute it is.
      const node = result.servers.find((s) => s.nodeId === nodeId && s.kind === 'rpcNode');
      return {
        completed: result.completed,
        rejected: result.rejected,
        reported: own !== undefined || node !== undefined,
        worked: own ? ('accepted' in own ? own.accepted : own.completed) : node ? node.admitted : 0,
      };
    }, id);
    expect(summary.completed, 'users were still answered').toBeGreaterThan(0);
    expect(summary.reported, 'the component reported its own numbers').toBe(true);
    expect(summary.worked, 'the component handled work').toBeGreaterThan(0);

    // ---- Its own numbers, on the card and in the sheet -------------------------
    await expect(page.locator('.react-flow__node').filter({ hasText: COMPONENT_LABELS[release.kind] })).toContainText(release.detail);
    await page.getByRole('button', { name: 'Expand results' }).click();
    await page.getByRole('tab', { name: 'Components' }).nth(1).click();
    await expect(page.getByText(release.section, { exact: true })).toBeVisible();
    await expect(page.getByText(release.detail).first()).toBeVisible();

    // ---- Priced from the provider's list, or honestly unpriced -----------------
    // Thirteen of the sixteen start on a verified AWS rate (entry 066). The
    // other three have nothing to read: Cognito bills per monthly active user,
    // and nobody sells a rate limiter or a mesh proxy on its own.
    await page.getByRole('tab', { name: 'Cost' }).click();
    const lines = await page.evaluate((nodeId) => {
      const estimate = window.aparecium!.store.getState().latestRun!.cost;
      return (estimate?.lines ?? [])
        .filter((l) => l.nodeId === nodeId)
        .map((l) => ({ unpriced: l.unpriced, monthly: l.monthly, verified: l.verified }));
    }, id);
    if (NO_COST_LINES.includes(release.kind)) {
      expect(lines, 'nothing to bill the app for').toEqual([]);
      expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
      return;
    }
    expect(lines.length, 'the cost sheet has a line for it').toBeGreaterThan(0);
    const stayUnpriced = UNPRICED_BY_DESIGN.includes(release.kind);
    for (const line of lines) {
      if (stayUnpriced) {
        expect(line.unpriced, 'unpriced, with a reason').toBe(true);
        expect(line.monthly).toBeNull();
      } else {
        expect(line.verified, 'a rate read from the provider').toBe(true);
        expect(line.unpriced).toBe(false);
        expect(Number(line.monthly), 'a number, never zero by default').toBeGreaterThan(0);
      }
    }

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
}
