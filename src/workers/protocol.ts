/**
 * The messages exchanged with the simulation worker.
 *
 * Every message carries a `runId`. Both sides ignore messages for a run that
 * is no longer the current one, which is what stops a slow, cancelled run from
 * overwriting the results of the run that replaced it.
 */
import type { ArchitectureDocument, SimulationLimits } from '../domain/types';
import type { ProgressUpdate, SimulationResult } from '../simulation/types';

export type WorkerRequest =
  | {
      type: 'run';
      runId: string;
      document: ArchitectureDocument;
      limits: SimulationLimits;
      continuous?: boolean;
    }
  | { type: 'cancel'; runId: string };

export type WorkerResponse =
  | { type: 'snapshot'; runId: string; result: SimulationResult }
  | { type: 'progress'; runId: string; progress: ProgressUpdate }
  | { type: 'result'; runId: string; result: SimulationResult }
  | { type: 'error'; runId: string; message: string };
