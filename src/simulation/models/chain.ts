/**
 * A smart contract on its chain.
 *
 * What a request does here depends on what it is. A read never reaches this
 * model: a node answers it from its copy of the chain. A transaction is
 * accepted into the pending pool — the mempool — and waits there for a block.
 *
 * Blocks come on a fixed beat. Each holds a fixed amount of gas, and a share
 * of it is taken by everyone else using the chain; the app's transactions fit
 * into the rest, oldest first. A transaction is done when it is in a block
 * and the chosen number of blocks exist on top of it, counting its own.
 *
 * The fee follows the chain's own rule (Ethereum's EIP-1559): the base fee of
 * the next block moves by up to an eighth, up when a block is more than half
 * full and down when it is less. Everyone else's demand is elastic — at twice
 * the fee they use half the space — which is what stops a busy chain's fee
 * rising for ever. The app's own transactions are not: they are the traffic
 * being measured, and they keep coming whatever the fee, so an app that needs
 * more than half of every block on its own does price itself up without end.
 * The model tracks the fee as a multiple of the starting fee, so a run shows
 * how much dearer its own traffic made the chain; what the starting fee is in
 * money is the person's to enter, because it changes minute by minute.
 *
 * What this does NOT model: priority tips and fee bidding (the pool is first
 * come, first served), reorganisations, dropped or replaced transactions,
 * contract execution failures, or finality beyond the confirmation count.
 */
import type { ChainNodeOf } from '../../domain/chain-services';
import { StreamingStat, TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import type { RandomStreams, Rng } from '../rng';
import { SupportServiceModel } from './support-service';
import type { SupportJob, SupportMetrics, SupportStart } from './support-service';

interface PendingTx {
  /** The request that sent it, or null for an oracle's update. */
  job: SupportJob | null;
  /** The oracle that sent it, for its own tally. */
  sourceId: string | null;
  gas: number;
  since: number;
}

export interface OracleTally {
  submitted: number;
  dropped: number;
  included: number;
  /** Submission to inclusion, for updates that made it into a block. */
  inclusion: StreamingStat;
  /** Gas at the starting fee, weighted by the fee of the block that took it. */
  feeWeightedGas: number;
  gas: number;
}

export class ChainContractModel extends SupportServiceModel {
  private readonly mempool = new RingQueue<PendingTx>();
  private readonly confirming = new Map<number, SupportJob>();
  private readonly txStream: Rng;
  /** The base fee as a multiple of the fee when the run started. */
  feeMultiplier = 1;
  feePeak = 1;
  readonly fullnessAcc = new TimeWeightedAccumulator(0);
  readonly mempoolAcc = new TimeWeightedAccumulator(0);
  blocks = 0;
  /** The app's own transactions that made it into a block. */
  included = 0;
  gasUsed = 0;
  feeWeightedGas = 0;
  readonly inclusion = new StreamingStat();
  readonly oracles = new Map<string, OracleTally>();

  constructor(readonly contract: ChainNodeOf<'smartContract'>, streams: RandomStreams) {
    super(contract, streams);
    this.txStream = streams.stream(`chain-tx:${contract.id}`);
  }

  get blockMs(): number {
    return this.contract.settings.blockSeconds * 1000;
  }

  override decideTx(): boolean {
    return this.txStream.bernoulli(this.contract.settings.writeShare);
  }

  get hasPending(): boolean {
    return this.mempool.length > 0;
  }

  /** Blocks are on a fixed beat: the first one strictly after `now`. */
  nextBlockAt(now: number): number {
    return (Math.floor(now / this.blockMs) + 1) * this.blockMs;
  }

  /**
   * Two kinds of event arrive for a transaction: its submission has been
   * processed (it was in a slot), or it has its confirmations (it was
   * confirming). A submission goes into the pool, or is refused when the pool
   * is full; a confirmation finishes the request.
   */
  override finish(id: number, now: number, start: SupportStart): { job: SupportJob; failure: string | null } | null {
    const submitted = this.active.get(id);
    if (submitted) {
      this.active.delete(id); this.busy.set(now, this.active.size);
      const next = this.waiting.shift(); if (next) this.start(next, now, start);
      if (this.mempool.length >= this.contract.settings.mempoolLimit) {
        this.rejected++;
        this.details.mempoolRefused = (this.details.mempoolRefused ?? 0) + 1;
        return { job: submitted, failure: 'mempool-full' };
      }
      this.mempool.push({ job: submitted, sourceId: null, gas: this.contract.settings.gasPerTx, since: now });
      this.mempoolAcc.set(now, this.mempool.length);
      return null;
    }
    const confirmed = this.confirming.get(id);
    if (confirmed) {
      this.confirming.delete(id);
      this.completed++;
      return { job: confirmed, failure: null };
    }
    return null;
  }

  /** An oracle's update, which nobody waits for. Refused when the pool is full. */
  submitDetached(sourceId: string, gas: number, now: number): boolean {
    const tally = this.oracleTally(sourceId);
    tally.submitted++;
    if (this.mempool.length >= this.contract.settings.mempoolLimit) { tally.dropped++; return false; }
    this.mempool.push({ job: null, sourceId, gas, since: now });
    this.mempoolAcc.set(now, this.mempool.length);
    return true;
  }

  oracleTally(sourceId: string): OracleTally {
    let tally = this.oracles.get(sourceId);
    if (!tally) {
      tally = { submitted: 0, dropped: 0, included: 0, inclusion: new StreamingStat(), feeWeightedGas: 0, gas: 0 };
      this.oracles.set(sourceId, tally);
    }
    return tally;
  }

  /**
   * One block. The pool is taken oldest first into the space everyone else
   * leaves, and the first transaction always goes in when the pool is not
   * empty, so a transaction bigger than that space is not stuck for ever.
   * Returns how many of the app's transactions it took, for indexers.
   */
  produceBlock(now: number, start: SupportStart): number {
    const s = this.contract.settings;
    const fee = this.feeMultiplier;
    // Everyone else's share at the starting fee, shrinking as the fee rises.
    const others = Math.min(0.99, s.backgroundShare / fee);
    const room = s.blockGasLimit * (1 - others);
    let used = 0;
    let appTxs = 0;
    while (this.mempool.length > 0) {
      const tx = this.mempool.peek()!;
      if (used > 0 && used + tx.gas > room) break;
      this.mempool.shift();
      used += tx.gas;
      if (tx.job) {
        appTxs++;
        this.included++;
        this.gasUsed += tx.gas;
        this.feeWeightedGas += tx.gas * fee;
        this.inclusion.record(now - tx.since);
        this.confirming.set(tx.job.id, tx.job);
        // Its own block counts as the first confirmation.
        start(tx.job.id, (s.confirmations - 1) * this.blockMs, now - tx.since);
      } else if (tx.sourceId) {
        const tally = this.oracleTally(tx.sourceId);
        tally.included++;
        tally.gas += tx.gas;
        tally.feeWeightedGas += tx.gas * fee;
        tally.inclusion.record(now - tx.since);
      }
    }
    this.mempoolAcc.set(now, this.mempool.length);
    const fullness = Math.min(1, (s.blockGasLimit * others + used) / s.blockGasLimit);
    this.fullnessAcc.set(now, fullness);
    this.blocks++;
    // EIP-1559: the next base fee moves by an eighth of how far this block
    // was from half full, as a share of half full.
    this.feeMultiplier = fee * (1 + 0.125 * (fullness - 0.5) / 0.5);
    this.feePeak = Math.max(this.feePeak, this.feeMultiplier);
    return appTxs;
  }

  override snapshot(now: number): SupportMetrics {
    const base = super.snapshot(now);
    return {
      ...base,
      // The card's bar: how full blocks were, everyone else's share included.
      utilisation: this.fullnessAcc.timeAverage(now),
      details: {
        ...base.details,
        blocks: this.blocks,
        transactions: this.included,
        pending: this.mempool.length,
        mempoolPeak: this.mempoolAcc.peak,
        confirming: this.confirming.size,
        inclusionMsAverage: this.inclusion.mean,
        inclusionMsMax: this.inclusion.count > 0 ? this.inclusion.max : 0,
        gasUsed: this.gasUsed,
        feeMultiplierAverage: this.gasUsed > 0 ? this.feeWeightedGas / this.gasUsed : this.feeMultiplier,
        feeMultiplierPeak: this.feePeak,
        feeMultiplierNow: this.feeMultiplier,
      },
    };
  }
}
