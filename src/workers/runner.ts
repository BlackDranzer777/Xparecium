import { SimulationEngine } from '../simulation/engine';
import type { SimulationInput, SimulationResult, ProgressUpdate } from '../simulation/types';

/** Shared scheduling for the worker and browser fallback. The engine has no clock. */
export function driveSimulation(input: SimulationInput, callbacks: {
  progress: (progress: ProgressUpdate) => void;
  snapshot: (result: SimulationResult) => void;
  finish: (result: SimulationResult) => void;
  error: (error: Error) => void;
}): () => void {
  const engine = new SimulationEngine(input);
  let timer: ReturnType<typeof setTimeout>;
  let closed = false;
  let lastTick = Date.now();
  let lastReport = lastTick;
  let horizon = 0;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    callbacks.finish(engine.result());
  };
  const tick = () => {
    if (closed) return;
    try {
      const start = Date.now();
      // Background throttling and overload slow simulated time instead of
      // creating a huge catch-up job when the tab returns.
      if (engine.progressUpdate.simulatedMs >= horizon) {
        horizon += Math.min(250, Math.max(0, start - lastTick));
      }
      lastTick = start;
      do {
        engine.step(1000, input.continuous ? horizon : Infinity);
        if (engine.isFinished) { finish(); return; }
        if (input.continuous && engine.progressUpdate.simulatedMs >= horizon) break;
      } while (Date.now() - start < 12);
      if (Date.now() - lastReport >= 250) {
        lastReport = Date.now();
        callbacks.progress(engine.progressUpdate);
        if (input.continuous) callbacks.snapshot(engine.result());
      }
      timer = setTimeout(tick, input.continuous ? 25 : 0);
    } catch (error) {
      closed = true;
      callbacks.error(error as Error);
    }
  };
  timer = setTimeout(tick, 0);
  return () => { if (!closed) { engine.cancel(); finish(); } };
}
