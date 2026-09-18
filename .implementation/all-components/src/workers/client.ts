/**
 * The main-thread side of the simulation worker.
 *
 * Responsibilities:
 *   - create the worker lazily, and fall back to running inline if a browser
 *     refuses to create one;
 *   - stamp every run with an id and drop any message that does not match the
 *     run currently in progress;
 *   - turn the message protocol into a promise plus a progress callback.
 */
import { DEFAULT_LIMITS } from '../domain/types';
import type { ArchitectureDocument, SimulationLimits } from '../domain/types';
import { driveSimulation } from './runner';
import type { ProgressUpdate, SimulationResult } from '../simulation/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface RunHandle {
  runId: string;
  result: Promise<SimulationResult>;
}

interface LiveOptions {
  continuous?: boolean;
  onSnapshot?: (result: SimulationResult) => void;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run-${Date.now().toString(36)}-${runCounter}`;
}

export class SimulationClient {
  private worker: Worker | null = null;
  private workerFailed = false;
  private activeRunId: string | null = null;
  private cancelInline: (() => void) | null = null;
  private handlers = new Map<
    string,
    {
      resolve: (result: SimulationResult) => void;
      reject: (error: Error) => void;
      onProgress?: (progress: ProgressUpdate) => void;
      onSnapshot?: (result: SimulationResult) => void;
    }
  >();

  /** True when the run is happening on the main thread instead of a worker. */
  get usingFallback(): boolean {
    return this.workerFailed;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (this.workerFailed) return null;
    try {
      const worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), {
        type: 'module',
        name: 'aparecium-simulation',
      });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.onMessage(event.data);
      worker.onerror = () => {
        this.failWorker(new Error('The simulation worker stopped unexpectedly. Run again to use the browser fallback.'));
      };
      worker.onmessageerror = () => this.failWorker(new Error('The simulation worker returned an unreadable message.'));
      this.worker = worker;
      return worker;
    } catch {
      this.workerFailed = true;
      return null;
    }
  }

  private failWorker(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerFailed = true;
    this.activeRunId = null;
    for (const handler of this.handlers.values()) handler.reject(error);
    this.handlers.clear();
  }

  private onMessage(message: WorkerResponse): void {
    const handler = this.handlers.get(message.runId);
    // A message for a run we have already settled and forgotten. Drop it.
    if (!handler) return;

    if (message.type === 'snapshot') {
      if (message.runId === this.activeRunId) handler.onSnapshot?.(message.result);
      return;
    }

    if (message.type === 'progress') {
      // Progress from a superseded run must never move the current run's bar.
      if (message.runId !== this.activeRunId) return;
      handler.onProgress?.(message.progress);
      return;
    }

    // Results always settle their own promise so nothing is left hanging, but
    // only the current run is allowed to clear the active slot. The caller
    // compares runId before displaying anything.
    this.handlers.delete(message.runId);
    if (message.runId === this.activeRunId) this.activeRunId = null;
    if (message.type === 'result') handler.resolve(message.result);
    else handler.reject(new Error(message.message));
  }

  run(
    document: ArchitectureDocument,
    limits: SimulationLimits = DEFAULT_LIMITS,
    onProgress?: (progress: ProgressUpdate) => void,
    options: LiveOptions = {},
  ): RunHandle {
    // Starting a run supersedes any run still in flight.
    this.cancel();

    const runId = nextRunId();
    this.activeRunId = runId;

    const worker = this.ensureWorker();
    if (!worker) {
      const result = new Promise<SimulationResult>((resolve, reject) => {
        this.cancelInline = driveSimulation({ document, limits, continuous: options.continuous ?? false }, {
          progress: p => { if (this.activeRunId === runId) onProgress?.(p); },
          snapshot: r => { if (this.activeRunId === runId) options.onSnapshot?.(r); },
          finish: r => { if (this.activeRunId === runId) this.activeRunId = null; resolve(r); },
          error: reject,
        });
      });
      return { runId, result };
    }

    const result = new Promise<SimulationResult>((resolve, reject) => {
      const entry: {
        resolve: (r: SimulationResult) => void;
        reject: (e: Error) => void;
        onProgress?: (p: ProgressUpdate) => void;
        onSnapshot?: (r: SimulationResult) => void;
      } = { resolve, reject };
      if (onProgress) entry.onProgress = onProgress;
      if (options.onSnapshot) entry.onSnapshot = options.onSnapshot;
      this.handlers.set(runId, entry);
      const request: WorkerRequest = { type: 'run', runId, document, limits, continuous: options.continuous ?? false };
      try { worker.postMessage(request); }
      catch { this.failWorker(new Error('Could not send the run to the simulation worker.')); }
    });
    return { runId, result };
  }

  /** Ask the current run to stop. Its promise still resolves, with a cancelled result. */
  cancel(): void {
    const runId = this.activeRunId;
    if (!runId) return;
    if (this.cancelInline) {
      this.cancelInline();
      this.cancelInline = null;
      return;
    }
    const request: WorkerRequest = { type: 'cancel', runId };
    this.worker?.postMessage(request);
  }

  dispose(): void {
    this.cancelInline?.();
    this.cancelInline = null;
    this.worker?.terminate();
    this.worker = null;
    for (const handler of this.handlers.values()) handler.reject(new Error('The simulation client was closed.'));
    this.handlers.clear();
    this.activeRunId = null;
  }
}

export const simulationClient = new SimulationClient();
