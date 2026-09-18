import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The diagram itself, rather than what it is showing.
 *
 * Traffic on the canvas is drawn with SVG `animateMotion`, which runs on the
 * browser's own clock. That makes it cheap, but it also means the animation
 * survives only as long as its DOM element does: anything that unmounts and
 * remounts a connection sends its dots back to the start, and the whole picture
 * looks as though the simulation restarted when nothing of the sort happened.
 * These tests pin the packets to the DOM elements they began on.
 */

const pageErrors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Run simulation' })).toBeEnabled();
  await page.getByLabel('Simulation mode').selectOption('live');
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByText('per month')).toBeVisible();
  // The three dots on a connection set off half a second apart, so the last of
  // them is still sitting at the start for the first second. Waiting for a
  // fixed time here is a race; waiting for the thing itself is not.
  await expect.poll(() => leastPacketMovement(page), { timeout: 15_000 }).toBeGreaterThan(1);
});

/** Stamp every packet and connection so a replaced one can be recognised. */
async function tagCanvas(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0;
    document.querySelectorAll<SVGGElement>('g.react-flow__edge').forEach((group, index) => {
      group.dataset.tag = `edge-${index}`;
    });
    document.querySelectorAll<SVGCircleElement>('.ap-packet').forEach((packet, index) => {
      packet.dataset.tag = `packet-${index}`;
      count += 1;
    });
    return count;
  });
}

async function survivingTags(page: Page): Promise<{ edges: number; packets: number }> {
  return page.evaluate(() => ({
    edges: [...document.querySelectorAll<SVGGElement>('g.react-flow__edge')].filter(
      (group) => group.dataset.tag !== undefined,
    ).length,
    packets: [...document.querySelectorAll<SVGCircleElement>('.ap-packet')].filter(
      (packet) => packet.dataset.tag !== undefined,
    ).length,
  }));
}

/**
 * How far the least-travelled dot moved, in pixels.
 *
 * Three samples rather than two: a dot that happens to loop back to where it
 * started between one sample and the next would otherwise read as stationary.
 * Every packet is checked, because a stalled animation is one element's problem
 * and the average would hide it.
 */
async function leastPacketMovement(page: Page): Promise<number> {
  const samples: { x: number; y: number }[][] = [];
  for (let i = 0; i < 3; i += 1) {
    if (i > 0) await page.waitForTimeout(150);
    samples.push(
      await page.evaluate(() =>
        [...document.querySelectorAll('.ap-packet')].map((packet) => {
          const box = packet.getBoundingClientRect();
          return { x: box.x, y: box.y };
        }),
      ),
    );
  }
  if (samples[0]!.length === 0) return 0;
  const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  return Math.min(
    ...samples[0]!.map((_, index) =>
      Math.max(
        distance(samples[0]![index]!, samples[1]![index]!),
        distance(samples[1]![index]!, samples[2]![index]!),
      ),
    ),
  );
}

async function dragNode(page: Page, kind: string, dx: number, dy: number) {
  const id = await page.evaluate(
    (wanted) =>
      window.aparecium!.store.getState().project!.document.nodes.find((n) => n.kind === wanted)!.id,
    kind,
  );
  const box = await page.locator(`[data-testid="rf__node-${id}"]`).boundingBox();
  const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from.x + (dx * step) / 10, from.y + (dy * step) / 10);
  }
  await page.mouse.up();
}

test('dragging a component does not restart the traffic on the diagram', async ({ page }) => {
  const tagged = await tagCanvas(page);
  expect(tagged).toBeGreaterThan(0);

  // A component every connection touches: its edges are redrawn as it moves.
  await dragNode(page, 'database', -60, 90);
  expect(await survivingTags(page)).toEqual({ edges: 2, packets: tagged });
  expect(await leastPacketMovement(page)).toBeGreaterThan(1);

  // And a component nothing is connected to, which is where this was reported.
  await page.evaluate(() => window.aparecium!.store.getState().addComponent('cache'));
  await expect(page.getByText('Cache').first()).toBeVisible();
  await dragNode(page, 'cache', 80, -60);
  expect(await survivingTags(page)).toEqual({ edges: 2, packets: tagged });
  expect(await leastPacketMovement(page)).toBeGreaterThan(1);
});

test('renaming a component does not restart the traffic on the diagram', async ({ page }) => {
  const tagged = await tagCanvas(page);
  await page.evaluate(() => {
    window.aparecium!.store.getState().mutate((draft) => {
      draft.nodes[0]!.name = 'Renamed';
    });
  });
  await expect(page.getByText('Renamed').first()).toBeVisible();
  expect(await survivingTags(page)).toEqual({ edges: 2, packets: tagged });
  expect(await leastPacketMovement(page)).toBeGreaterThan(1);
});
