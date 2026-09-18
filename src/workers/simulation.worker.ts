/// <reference lib="webworker" />
import { driveSimulation } from './runner';
import type { WorkerRequest, WorkerResponse } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let active: { id: string; cancel: () => void } | null = null;
const post = (message: WorkerResponse) => ctx.postMessage(message);

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (active?.id === message.runId) { active.cancel(); active = null; }
    return;
  }
  active?.cancel();
  const runId = message.runId;
  try {
    active = { id: runId, cancel: driveSimulation({
      document: message.document, limits: message.limits, continuous: message.continuous ?? false,
    }, {
      progress: progress => post({ type: 'progress', runId, progress }),
      snapshot: result => post({ type: 'snapshot', runId, result }),
      finish: result => { post({ type: 'result', runId, result }); if (active?.id === runId) active = null; },
      error: error => { post({ type: 'error', runId, message: error.message }); if (active?.id === runId) active = null; },
    }) };
  } catch (error) {
    active = null;
    post({ type: 'error', runId, message: (error as Error).message });
  }
};
