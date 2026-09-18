import { describe, expect, it } from 'vitest';
import { runSimulation } from '../src/simulation/engine';
import { validateAndResolve } from '../src/simulation/routing';
import type { ArchEdge, ArchNode } from '../src/domain/types';
import { client, database, doc, edge, queue, server, INSTANT } from './helpers';

/**
 * Work that outlives the request that created it.
 *
 * Everything else the engine models is synchronous: the caller waits for each
 * downstream call and gets an answer at the end. A message queue is the first
 * thing that breaks that — the server hands the work over, answers its caller
 * immediately, and the consumer works through the backlog at its own pace. The
 * trade that buys, and what it costs when the consumer cannot keep up, is what
 * these tests pin down.
 */

/**
 * Users -> server -> queue -> worker.
 *
 * No network delay, no payload bytes and no cache or database, so every
 * millisecond in the result is CPU that was asked for by name. (INSTANT is a
 * very fast link, not an infinitely fast one, so bytes would still cost a
 * fraction of a microsecond and spoil the exact arithmetic.)
 */
function asyncDocument(options: {
  ratePerSecond?: number;
  serverCpuMs?: number;
  workerCpuMs?: number;
  workerConcurrency?: number;
  maxDepth?: number;
  durationSeconds?: number;
  drainSeconds?: number;
  workerHasDatabase?: boolean;
}) {
  const {
    ratePerSecond = 10,
    serverCpuMs = 10,
    workerCpuMs = 200,
    workerConcurrency = 1,
    maxDepth = 1_000_000,
    durationSeconds = 100,
    drainSeconds = 10,
    workerHasDatabase = false,
  } = options;

  const nodes: ArchNode[] = [
    client('c1', { requestRateOverridePerSecond: ratePerSecond, requestBytes: 0, responseBytes: 0 }),
    server('s1', {
      profile: 'custom',
      cpuSlots: 64,
      cpuMsPerRequest: serverCpuMs,
      concurrencyLimit: 100_000,
      ramMb: 10_000_000,
      queueLimit: 1_000_000,
    }),
    queue('q1', { maxDepth, publishServiceTimeMs: 0, messageBytes: 0 }),
    server('w1', {
      profile: 'custom',
      cpuSlots: workerConcurrency,
      cpuMsPerRequest: workerCpuMs,
      concurrencyLimit: workerConcurrency,
      ramMb: 10_000_000,
      queueLimit: 1_000_000,
    }),
  ];
  const edges: ArchEdge[] = [
    edge('c1', 's1', INSTANT),
    edge('s1', 'q1', INSTANT),
    edge('q1', 'w1', INSTANT),
  ];
  if (workerHasDatabase) {
    nodes.push(database('d1', { queryServiceTimeMs: 1, maxConcurrentQueries: 64 }));
    edges.push(edge('w1', 'd1', INSTANT));
  }
  return doc(nodes, edges, { durationSeconds, drainSeconds, seed: 5 });
}

describe('publishing to a queue', () => {
  it('answers the caller without waiting for the work to be done', () => {
    // The server does 10 ms of CPU and publishes. The worker takes 200 ms per
    // message — twenty times longer — and the caller never sees any of it.
    const result = runSimulation(
      asyncDocument({ ratePerSecond: 1, serverCpuMs: 10, workerCpuMs: 200, durationSeconds: 20 }),
    );

    expect(result.status).toBe('completed');
    expect(result.offered).toBe(20);
    expect(result.completed).toBe(20);
    expect(result.responseTime.meanMs).toBeCloseTo(10, 9);
    expect(result.responseTime.maxMs).toBeCloseTo(10, 9);
  });

  it('splits the same CPU work across one more segment, rather than adding any', () => {
    // Publishing is a downstream call like a database read: the server's CPU
    // work is divided around it, not increased by it. Ten milliseconds with a
    // queue is still ten milliseconds.
    const withQueue = runSimulation(
      asyncDocument({ ratePerSecond: 1, serverCpuMs: 10, durationSeconds: 20 }),
    );
    const withoutQueue = runSimulation(
      doc(
        [
          client('c1', { requestRateOverridePerSecond: 1, requestBytes: 0, responseBytes: 0 }),
          server('s1', {
            profile: 'custom',
            cpuSlots: 64,
            cpuMsPerRequest: 10,
            concurrencyLimit: 100_000,
            ramMb: 10_000_000,
          }),
        ],
        [edge('c1', 's1', INSTANT)],
        { durationSeconds: 20, drainSeconds: 10, seed: 5 },
      ),
    );
    expect(withQueue.responseTime.meanMs).toBeCloseTo(withoutQueue.responseTime.meanMs, 9);
  });

  it('counts every message it accepted and every one it finished', () => {
    const result = runSimulation(
      asyncDocument({ ratePerSecond: 1, workerCpuMs: 1, durationSeconds: 20, drainSeconds: 20 }),
    );
    const q = result.queues[0]!;
    expect(result.queues).toHaveLength(1);
    expect(q.name).toBe('q1');
    expect(q.consumerName).toBe('w1');
    expect(q.enqueued).toBe(20);
    expect(result.messagesPublished).toBe(20);
    // A worker that takes 1 ms drains 20 messages long before the run ends.
    expect(q.processed).toBe(20);
    expect(q.outstanding).toBe(0);
    expect(result.messagesProcessed).toBe(20);
    expect(q.refused).toBe(0);
  });
});

describe('a consumer that cannot keep up', () => {
  it('leaves a backlog the arithmetic predicts', () => {
    // 10 messages a second for 100 seconds is 1,000 published. One worker at
    // 200 ms a message finishes 5 a second, and it keeps going through the
    // drain: 110 seconds of work at 5 a second is 550 finished, leaving 450.
    const result = runSimulation(
      asyncDocument({
        ratePerSecond: 10,
        workerCpuMs: 200,
        workerConcurrency: 1,
        durationSeconds: 100,
        drainSeconds: 10,
      }),
    );

    const q = result.queues[0]!;
    expect(q.enqueued).toBe(1000);
    expect(q.processed).toBeGreaterThan(545);
    expect(q.processed).toBeLessThanOrEqual(551);
    expect(q.outstanding).toBe(q.enqueued - q.processed);
    expect(q.outstanding).toBeGreaterThan(445);

    // The backlog is what grew; the callers never noticed.
    expect(result.completed).toBe(1000);
    expect(result.responseTime.maxMs).toBeCloseTo(10, 6);
    expect(q.depthPeak).toBeGreaterThan(400);
  });

  it('refuses a publish when the backlog is full, rather than dropping it quietly', () => {
    // A queue that holds ten messages, and a worker far too slow to drain it.
    const result = runSimulation(
      asyncDocument({
        ratePerSecond: 10,
        workerCpuMs: 5_000,
        workerConcurrency: 1,
        maxDepth: 10,
        durationSeconds: 100,
        drainSeconds: 10,
      }),
    );

    const q = result.queues[0]!;
    // Ten fit at once, and one more gets in each time the worker frees a slot:
    // 110 seconds at 5 seconds a message is about 22 more.
    expect(q.enqueued).toBeGreaterThan(10);
    expect(q.enqueued).toBeLessThan(40);
    expect(q.refused).toBeGreaterThan(900);
    expect(q.depthPeak).toBe(10);

    // A refused publish is a failed request, and it is reported as one.
    expect(result.rejected).toBe(q.refused);
    expect(result.rejectionsByReason['queue-full']).toBe(q.refused);
    expect(result.completed + result.rejected).toBe(result.offered);
  });

  it('lets the worker use a database of its own', () => {
    // A consumer is an ordinary Application Server, so everything a server can
    // do it can do. This is why there is no separate Worker component.
    const result = runSimulation(
      asyncDocument({
        ratePerSecond: 1,
        workerCpuMs: 1,
        workerHasDatabase: true,
        durationSeconds: 20,
        drainSeconds: 20,
      }),
    );
    expect(result.queues[0]!.processed).toBe(20);
    // One query per message, and none from the user-facing server.
    expect(result.databaseQueries).toBe(20);
  });

  it('is reproducible from its seed', () => {
    const a = runSimulation(asyncDocument({ durationSeconds: 40 }));
    const b = runSimulation(asyncDocument({ durationSeconds: 40 }));
    expect(b.queues[0]!.processed).toBe(a.queues[0]!.processed);
    expect(b.queues[0]!.outstanding).toBe(a.queues[0]!.outstanding);
  });
});

describe('what the results say about a backlog', () => {
  it('does not claim nothing had to wait while a queue is filling', () => {
    const result = runSimulation(
      asyncDocument({ ratePerSecond: 10, workerCpuMs: 200, durationSeconds: 100 }),
    );
    const titles = result.findings.map((f) => f.title).join(' | ');
    expect(titles).toContain('still had');
    expect(titles).toContain('messages waiting');
    const backlogFinding = result.findings.find((f) => f.id.startsWith('queue-backlog-'));
    expect(backlogFinding?.severity).toBe('warning');
  });

  it('says so plainly when the consumer kept up', () => {
    const result = runSimulation(
      asyncDocument({ ratePerSecond: 1, workerCpuMs: 1, durationSeconds: 20, drainSeconds: 20 }),
    );
    expect(result.findings.map((f) => f.title).join(' | ')).toContain('kept up');
  });

  it('reports refused publishes as the warning they are', () => {
    const result = runSimulation(
      asyncDocument({
        ratePerSecond: 10,
        workerCpuMs: 5_000,
        maxDepth: 10,
        durationSeconds: 100,
      }),
    );
    const refused = result.findings.find((f) => f.id.startsWith('queue-refused-'));
    expect(refused?.severity).toBe('warning');
    expect(refused?.detail).toContain('backlog reached its limit');
  });
});

describe('what a queue may be connected to', () => {
  function issuesFor(nodes: ArchNode[], edges: ArchEdge[]) {
    return validateAndResolve(doc(nodes, edges)).issues.map((i) => i.code);
  }

  it('refuses a server that publishes to two queues', () => {
    const codes = issuesFor(
      [client('c1'), server('s1'), queue('q1'), queue('q2'), server('w1'), server('w2')],
      [
        edge('c1', 's1', INSTANT),
        edge('s1', 'q1', INSTANT),
        edge('s1', 'q2', INSTANT),
        edge('q1', 'w1', INSTANT),
        edge('q2', 'w2', INSTANT),
      ],
    );
    expect(codes).toContain('route/server-multiple-queues');
  });

  it('refuses a queue with nothing draining it', () => {
    const codes = issuesFor(
      [client('c1'), server('s1'), queue('q1')],
      [edge('c1', 's1', INSTANT), edge('s1', 'q1', INSTANT)],
    );
    expect(codes).toContain('route/queue-no-consumer');
  });

  it('refuses a queue drained by something that is not a server', () => {
    const codes = issuesFor(
      [client('c1'), server('s1'), queue('q1'), database('d1')],
      [edge('c1', 's1', INSTANT), edge('s1', 'q1', INSTANT), edge('q1', 'd1', INSTANT)],
    );
    expect(codes).toContain('route/queue-unsupported-consumer');
  });

  it('refuses two consumers on one queue', () => {
    const codes = issuesFor(
      [client('c1'), server('s1'), queue('q1'), server('w1'), server('w2')],
      [
        edge('c1', 's1', INSTANT),
        edge('s1', 'q1', INSTANT),
        edge('q1', 'w1', INSTANT),
        edge('q1', 'w2', INSTANT),
      ],
    );
    expect(codes).toContain('route/queue-multiple-consumers');
  });

  it('refuses a worker that publishes back into the queue it drains', () => {
    // Work would be created faster than it could ever be finished. Nothing in
    // the resolver needed a cycle check before queues existed, because a server
    // could not reach another server at all.
    const codes = issuesFor(
      [client('c1'), server('s1'), queue('q1'), server('w1')],
      [
        edge('c1', 's1', INSTANT),
        edge('s1', 'q1', INSTANT),
        edge('q1', 'w1', INSTANT),
        edge('w1', 'q1', INSTANT),
      ],
    );
    expect(codes).toContain('route/queue-cycle');
  });

  it('does not call a worker unreachable just because no user talks to it', () => {
    const routing = validateAndResolve(
      doc(
        [client('c1'), server('s1'), queue('q1'), server('w1')],
        [edge('c1', 's1', INSTANT), edge('s1', 'q1', INSTANT), edge('q1', 'w1', INSTANT)],
      ),
    );
    expect(routing.hasErrors).toBe(false);
    expect(routing.reachable.has('w1')).toBe(true);
    expect(routing.issues.filter((i) => i.code === 'topology/unreachable')).toHaveLength(0);
  });
});
