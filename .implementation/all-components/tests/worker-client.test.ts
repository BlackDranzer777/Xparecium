import { afterEach, expect, it, vi } from 'vitest';
import { SimulationClient } from '../src/workers/client';
import { buildTemplate } from '../src/domain/defaults';

afterEach(() => vi.unstubAllGlobals());

it('settles pending runs when a worker crashes and permits a fallback run', async () => {
  let crash: (() => void) | undefined;
  vi.stubGlobal('Worker', class {
    set onerror(handler: () => void) { crash = handler; }
    postMessage() {}
    terminate() {}
  });
  const client = new SimulationClient();
  const run = client.run(buildTemplate('starter'));
  const rejected = expect(run.result).rejects.toThrow(/worker/i);
  crash!();
  await rejected;
  const retry = await client.run(buildTemplate('starter')).result;
  expect(retry.status).toBe('completed');
  expect(client.usingFallback).toBe(true);
  client.dispose();
});
