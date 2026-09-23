import { describe, expect, it } from 'vitest';
import rawCatalog from '../public/catalogs/cloud-profiles.v1.json';
import { cloudCatalogSchema } from '../src/catalogs/types';
import { CHAIN_KINDS, CHAIN_SERVICES } from '../src/domain/chain-services';
import { buildTemplate, isReleased, makeNode, releasedTemplates, upgradeDocument } from '../src/domain/defaults';
import { architectureDocumentSchema } from '../src/domain/schema';
import { DEFAULT_LIMITS, DOCUMENT_SCHEMA_VERSION } from '../src/domain/types';
import type { ArchitectureDocument, ArchNode } from '../src/domain/types';
import { estimateCost } from '../src/pricing/pricing';
import { runSimulation, SimulationEngine } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import { createRunRecord } from '../src/storage/runs';
import { runRecordSchema } from '../src/storage/run-schema';
import { client, doc, edge, server, INSTANT } from './helpers';

/**
 * The blockchain pieces (entry 076), held to what makes a chain different:
 * a transaction waits for a block and its confirmations, a block holds a
 * fixed amount of gas, the fee moves by the chain's own rule, reads never
 * wait, a person signs, a node has a plan limit, an indexer can fall behind,
 * an oracle takes block space, and storage is fast only when cached.
 */

const catalog = cloudCatalogSchema.parse(rawCatalog);

function chainNode<K extends (typeof CHAIN_KINDS)[number]>(kind: K, id: string, settings: Record<string, number> = {}): ArchNode {
  const node = makeNode(kind, id, id, { x: 0, y: 0 });
  Object.assign(node.settings as Record<string, number>, settings);
  return node;
}

/** Users -> [wallet] -> RPC node -> contract, all instant links. */
function mintPath(contract: Record<string, number> = {}, options: { rate?: number; wallet?: Record<string, number> | null; rpc?: Record<string, number>; seconds?: number } = {}): ArchitectureDocument {
  const withWallet = options.wallet !== null;
  const nodes = [client('u', { requestRateOverridePerSecond: options.rate ?? 20, requestBytes: 0, responseBytes: 0 }),
    ...(withWallet ? [chainNode('wallet', 'wallet', options.wallet ?? {})] : []),
    chainNode('rpcNode', 'rpc', options.rpc ?? {}), chainNode('smartContract', 'contract', contract)];
  const edges = withWallet
    ? [edge('u', 'wallet', INSTANT), edge('wallet', 'rpc', INSTANT), edge('rpc', 'contract', INSTANT)]
    : [edge('u', 'rpc', INSTANT), edge('rpc', 'contract', INSTANT)];
  return doc(nodes, edges, { durationSeconds: options.seconds ?? 30, drainSeconds: 60 });
}
const chainOf = (r: ReturnType<typeof runSimulation>, kind: string) => r.chainServices!.find((s) => s.kind === kind)!;

describe('smart contract', () => {
  it('a transaction waits for the next block and its confirmations; a read does not wait at all', () => {
    // Every call a transaction, on 12-second blocks with two confirmations.
    const writes = runSimulation(mintPath({ writeShare: 1, blockSeconds: 12, confirmations: 2 }, { wallet: null }));
    const c = chainOf(writes, 'smartContract');
    expect(writes.rejected).toBe(0);
    expect(c.details.transactions).toBe(writes.completed);
    // Half a block on average to be included, then one more block for the second confirmation.
    expect(c.details.inclusionMsAverage).toBeGreaterThan(5000);
    expect(c.details.inclusionMsAverage).toBeLessThan(7000);
    expect(writes.responseTime.meanMs).toBeGreaterThan(17_000);
    expect(writes.responseTime.meanMs).toBeLessThan(19_000);
    // Every call a read: answered by the node, never near a block.
    const reads = runSimulation(mintPath({ writeShare: 0 }, { wallet: null }));
    expect(chainOf(reads, 'smartContract').details.transactions).toBe(0);
    expect(chainOf(reads, 'smartContract').details.reads).toBe(reads.completed);
    expect(reads.responseTime.meanMs).toBeLessThan(25);
  });

  it('shorter blocks and fewer confirmations are what makes a layer-2 chain feel fast', () => {
    const slow = runSimulation(mintPath({ writeShare: 1, blockSeconds: 12, confirmations: 2 }, { wallet: null }));
    const fast = runSimulation(mintPath({ writeShare: 1, blockSeconds: 2, confirmations: 1 }, { wallet: null }));
    expect(fast.responseTime.meanMs).toBeLessThan(slow.responseTime.meanMs / 10);
  });

  it('a block holds a fixed amount of gas: the chain caps throughput, and the rest wait', () => {
    // Room for exactly 10 transactions a block (1,000,000 gas, half taken by others,
    // 50,000 each), every 2 s: 5 a second. 20 a second arrive.
    const r = runSimulation(mintPath({ writeShare: 1, blockSeconds: 2, blockGasLimit: 1_000_000, backgroundShare: 0.5, gasPerTx: 50_000, confirmations: 1 }, { wallet: null, seconds: 20 }));
    const c = chainOf(r, 'smartContract');
    // The first blocks take 10 each; the fee then rises and others step back, making a little more room.
    expect(c.details.mempoolPeak).toBeGreaterThan(100);
    expect(c.details.inclusionMsAverage).toBeGreaterThan(10_000);
  });

  it('full blocks raise the fee by the chain’s own rule, and half-full blocks leave it alone', () => {
    const quiet = chainOf(runSimulation(mintPath({ writeShare: 1, blockSeconds: 2, backgroundShare: 0.5, blockGasLimit: 30_000_000 }, { wallet: null, rate: 1 })), 'smartContract');
    expect(quiet.details.feeMultiplierPeak).toBeLessThan(1.01);
    // Others fill 95% of each block at the starting fee: every block is full
    // until the fee has risen enough for them to step back.
    const busy = chainOf(runSimulation(mintPath({ writeShare: 1, blockSeconds: 2, backgroundShare: 0.95 }, { wallet: null, rate: 1 })), 'smartContract');
    expect(busy.details.feeMultiplierPeak).toBeGreaterThan(1.5);
    // EIP-1559 moves the fee by at most an eighth a block.
    expect(busy.details.feeMultiplierPeak).toBeLessThanOrEqual(Math.pow(1.125, busy.details.blocks!) + 1e-9);
    // With others stepping back as the fee rises, it settles near where they fill half.
    expect(busy.details.feeMultiplierNow).toBeLessThan(2.5);
  });

  it('a full pending pool refuses the transaction, and says so', () => {
    const r = runSimulation(mintPath({ writeShare: 1, blockSeconds: 30, mempoolLimit: 5 }, { wallet: null, seconds: 5 }));
    expect(r.rejectionsByReason['mempool-full']).toBeGreaterThan(0);
  });

  it('bills the gas its transactions used, weighted by the fee of the block that took each', () => {
    const d = mintPath({ writeShare: 1, blockSeconds: 2, gasPerTx: 60_000, backgroundShare: 0.9 }, { wallet: null });
    const r = runSimulation(d);
    const used = r.usage.gasByNodeId!.contract!;
    const weighted = r.usage.feeWeightedGasByNodeId!.contract!;
    expect(used).toBe(chainOf(r, 'smartContract').details.transactions! * 60_000);
    expect(weighted).toBeGreaterThan(used);
    const line = estimateCost({ document: d, catalog, usage: r.usage }).lines.find((l) => l.nodeId === 'contract')!;
    // No list can say what gas costs today: unpriced, with the reason and the formula.
    expect(line.chargeType).toBe('gas');
    expect(line.unpriced).toBe(true);
    expect(line.unpricedReason).toMatch(/base fee in gwei, times the token price/);
    expect(Number(line.quantity)).toBeCloseTo((weighted / r.usage.measuredSeconds) * 730 * 3600 / 1e6, 2);
    // With today's rate entered, the line is a number and says it was edited.
    d.pricingOverrides = { 'generic.smartContract': { gas: '60' } };
    const priced = estimateCost({ document: d, catalog, usage: r.usage }).lines.find((l) => l.nodeId === 'contract')!;
    expect(priced.unpriced).toBe(false);
    expect(priced.edited).toBe(true);
    expect(Number(priced.monthly)).toBeCloseTo(Number(line.quantity) * 60, 0);
  });
});

describe('wallet', () => {
  it('signs only transactions, takes the person’s time, and some are refused', () => {
    const r = runSimulation(mintPath({}, { wallet: { transactionShare: 0.3, rejectShare: 0.1, serviceTimeMs: 4000 } }));
    const w = chainOf(r, 'wallet');
    const c = chainOf(r, 'smartContract');
    expect(w.details.signed! + w.details.walletRefused! + w.details.passedThrough!).toBe(r.offered);
    expect(w.details.passedThrough! / r.offered).toBeGreaterThan(0.6);
    expect(r.rejectionsByReason['wallet-rejected']).toBe(w.details.walletRefused);
    // What the wallet signed is exactly what the chain received as transactions,
    // and what it let through as reads the chain answered as reads.
    expect(c.details.transactions).toBe(w.details.signed);
    expect(c.details.reads).toBe(w.details.passedThrough);
  });

  it('a wallet costs the app nothing', () => {
    const d = mintPath();
    const lines = estimateCost({ document: d, catalog, usage: runSimulation(d).usage }).lines.filter((l) => l.nodeId === 'wallet');
    expect(lines).toEqual([]);
  });
});

describe('RPC node', () => {
  it('refuses what is over its plan limit instead of queueing it', () => {
    const r = runSimulation(mintPath({}, { wallet: null, rpc: { ratePerSecond: 5, burstCapacity: 5 } }));
    const rpc = r.servers.find((s) => s.nodeId === 'rpc')!;
    expect(rpc.kind).toBe('rpcNode');
    expect(rpc.throttled).toBeGreaterThan(400);
    expect(r.rejectionsByReason['rpc-rate-limited']).toBe(rpc.throttled);
    expect(r.usage.requestsByNodeId.rpc).toBe(rpc.admitted);
  });

  it('calls one smart contract and nothing else', () => {
    const d = mintPath();
    d.nodes.push(makeNode('database', 'db', 'db', { x: 0, y: 0 }));
    d.edges.push(edge('rpc', 'db', INSTANT));
    expect(validateAndResolve(d).issues.map((i) => i.code)).toContain('route/rpc-target');
  });
});

/** A contract with an oracle and an indexer, and an API that reads the indexer and storage. */
function fullDapp(contract: Record<string, number> = {}, indexer: Record<string, number> = {}, oracle: Record<string, number> = {}): ArchitectureDocument {
  const d = mintPath({ blockSeconds: 2, confirmations: 1, ...contract }, { wallet: null });
  d.nodes.push(chainNode('oracle', 'oracle', oracle), chainNode('indexer', 'idx', indexer), chainNode('ipfs', 'ipfs'),
    client('v', { requestRateOverridePerSecond: 20, requestBytes: 0, responseBytes: 0 }), server('api'));
  d.edges.push(edge('oracle', 'contract', INSTANT), edge('contract', 'idx', INSTANT), edge('v', 'api', INSTANT), edge('api', 'idx', INSTANT), edge('api', 'ipfs', INSTANT));
  return d;
}

describe('indexer, oracle and storage', () => {
  it('an indexer falls behind when the chain brings more work than it can index', () => {
    const light = chainOf(runSimulation(fullDapp({ writeShare: 0.2 }, { indexMsPerTx: 5 })), 'indexer');
    const heavy = chainOf(runSimulation(fullDapp({ writeShare: 1 }, { indexMsPerTx: 150 })), 'indexer');
    expect(light.details.lagAverageMs).toBeLessThan(500);
    // 40 transactions a block at 150 ms each is 6 s of work every 2 s.
    expect(heavy.details.lagAverageMs).toBeGreaterThan(10_000);
    expect(heavy.details.lagPeakMs).toBeGreaterThan(heavy.details.lagAverageMs!);
    expect(heavy.details.blocksIndexed).toBeGreaterThan(10);
  });

  it('an oracle’s updates go through blocks like any transaction, and how stale the value got is reported', () => {
    const r = runSimulation(fullDapp({}, {}, { heartbeatSeconds: 5, gasPerUpdate: 100_000 }));
    const o = chainOf(r, 'oracle');
    expect(o.details.updates).toBe(5);
    expect(o.details.included).toBe(5);
    expect(o.details.maxAgeMs).toBeGreaterThanOrEqual(5000);
    expect(r.usage.gasByNodeId!.oracle).toBe(5 * 100_000);
    expect(validateAndResolve(r.issues.length ? fullDapp() : fullDapp()).hasErrors).toBe(false);
    // An oracle needs exactly one contract.
    const loose = fullDapp(); loose.edges = loose.edges.filter((e) => e.source !== 'oracle');
    expect(validateAndResolve(loose).issues.map((i) => i.code)).toContain('route/oracle-target');
  });

  it('storage is quick from a gateway’s cache and slow from the network', () => {
    const cached = runSimulation(fullDapp());
    const cold = (() => { const d = fullDapp(); Object.assign(d.nodes.find((n) => n.id === 'ipfs')!.settings, { gatewayHitShare: 0, writeShare: 0 }); return runSimulation(d); })();
    const s = chainOf(cached, 'ipfs');
    expect(s.details.gatewayHits! + s.details.networkFetches! + s.details.uploads!).toBe(s.accepted);
    const api = (r: ReturnType<typeof runSimulation>) => r.clients.find((c) => c.nodeId === 'v')!.meanResponseMs;
    expect(api(cold)).toBeGreaterThan(api(cached) + 1000);
  });
});

describe('persistence, pricing and the workshop', () => {
  it('every piece validates, rejects bad values, and a saved run keeps its numbers', () => {
    const d = fullDapp();
    d.nodes.push(chainNode('wallet', 'w2'));
    expect(architectureDocumentSchema.parse(JSON.parse(JSON.stringify(d)))).toEqual(d);
    for (const kind of CHAIN_KINDS) {
      const target = d.nodes.find((n) => n.kind === kind)!;
      for (const key of Object.keys(CHAIN_SERVICES[kind].fields)) {
        const bad = structuredClone(d);
        Object.assign(bad.nodes.find((n) => n.id === target.id)!.settings, { [key]: -1 });
        expect(architectureDocumentSchema.safeParse(bad).success, `${kind}.${key}`).toBe(false);
      }
    }
    const result = runSimulation(fullDapp());
    const cost = estimateCost({ document: fullDapp(), catalog, usage: result.usage });
    const reread = runRecordSchema.parse(JSON.parse(JSON.stringify(createRunRecord({ projectId: 'p', label: 'chain', document: fullDapp(), catalog, result, cost }))));
    expect(reread.result.chainServices).toEqual(result.chainServices);
    expect(reread.result.usage.gasByNodeId).toEqual(result.usage.gasByNodeId);
  });

  it('every piece starts on an honest, rate-less profile', () => {
    for (const kind of CHAIN_KINDS) {
      const profile = catalog.profiles.find((p) => p.id === `generic.${kind}`)!;
      expect(profile, kind).toBeDefined();
      expect(profile.verified).toBe(false);
      expect(profile.priceNote).toMatch(/^No rates supplied\./);
      expect(Object.values(profile.charges).every((c) => c.amount === null)).toBe(true);
    }
  });

  it('Live mode keeps the chain’s beat; a Timed run stops it once nothing is waiting', () => {
    const timed = runSimulation(mintPath({ writeShare: 1, blockSeconds: 2, confirmations: 1 }, { wallet: null, seconds: 10 }));
    expect(timed.usage.measuredSeconds).toBeLessThan(13);
    const live = new SimulationEngine({ document: mintPath({ blockSeconds: 2 }, { wallet: null }), limits: DEFAULT_LIMITS, continuous: true });
    live.step(10_000_000, 60_000);
    // Blocks at 2, 4, … 58 s: a slice ends before its boundary, so the one at 60 s is the next slice's.
    expect(chainOf(live.result(), 'smartContract').details.blocks).toBe(29);
  });

  it('documents are version 8; a version 7 one opens unchanged', () => {
    expect(DOCUMENT_SCHEMA_VERSION).toBe(8);
    const older = { ...buildTemplate('starter'), schemaVersion: 7 };
    const upgraded = upgradeDocument(older);
    expect(upgraded.schemaVersion).toBe(8);
    expect(upgraded.nodes).toEqual(older.nodes);
  });

  it('the NFT drop workshop is offered, valid, and runs clean', () => {
    for (const kind of CHAIN_KINDS) expect(isReleased(kind), kind).toBe(true);
    expect(releasedTemplates().some((t) => t.id === 'blockchain-workshop')).toBe(true);
    const d = buildTemplate('blockchain-workshop');
    expect(validateAndResolve(d).issues).toEqual([]);
    const r = runSimulation(d);
    expect(r.status).toBe('completed');
    const c = chainOf(r, 'smartContract');
    expect(c.details.transactions).toBe(chainOf(r, 'wallet').details.signed);
    expect(chainOf(r, 'oracle').details.included).toBeGreaterThan(0);
    expect(chainOf(r, 'indexer').details.blocksIndexed).toBeGreaterThan(0);
  });
});
