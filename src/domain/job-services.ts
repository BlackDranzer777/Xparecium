import type { NodeBase } from './types';
import type { NumericSetting } from './data-services';

export interface EventStreamSettings {
  partitions: number;
  maxDepth: number;
  retentionSeconds: number;
  consumerStartSeconds: number;
  startPosition: 'earliest' | 'latest';
  publishServiceTimeMs: number;
  maxConcurrentPublishes: number;
  publishQueueLimit: number;
  messageBytes: number;
}
export interface DeadLetterSettings {
  maxDepth: number;
  retentionSeconds: number;
  messageBytes: number;
  replayEnabled: boolean;
  replayDelaySeconds: number;
}
export interface SchedulerSettings {
  intervalSeconds: number;
  startAfterSeconds: number;
  batchSize: number;
  maxConcurrentJobs: number;
  requestBytes: number;
  responseBytes: number;
}
/**
 * A workflow runs one job as ordered steps. Its fields deliberately share the
 * Message Queue's names — accepting a start is a publish, each step waits in
 * a backlog like a queued message, and a failed step retries the way a queued
 * job does — so the engine drives both with the same machinery.
 */
export interface WorkflowSettings {
  publishServiceTimeMs: number;
  maxConcurrentPublishes: number;
  publishQueueLimit: number;
  messageBytes: number;
  maxDepth: number;
  transitionMs: number;
  processingFailureShare: number;
  maxAttempts: number;
  retryDelayMs: number;
}
export type EventStreamNode = NodeBase & { kind: 'eventStream'; settings: EventStreamSettings };
export type DeadLetterNode = NodeBase & { kind: 'deadLetter'; settings: DeadLetterSettings };
export type SchedulerNode = NodeBase & { kind: 'scheduler'; settings: SchedulerSettings };
export type WorkflowNode = NodeBase & { kind: 'workflow'; settings: WorkflowSettings };
export type JobServiceNode = EventStreamNode | DeadLetterNode | SchedulerNode | WorkflowNode;
export type JobKind = JobServiceNode['kind'];
export const JOB_KINDS = ['eventStream', 'deadLetter', 'scheduler', 'workflow'] as const;
export const isJobKind = (kind: string): kind is JobKind => (JOB_KINDS as readonly string[]).includes(kind);

export const DEFAULT_EVENT_STREAM: EventStreamSettings = {
  partitions: 4, maxDepth: 10000, retentionSeconds: 60, consumerStartSeconds: 0, startPosition: 'earliest',
  publishServiceTimeMs: 1, maxConcurrentPublishes: 32, publishQueueLimit: 1000, messageBytes: 1024,
};
export const DEFAULT_DEAD_LETTER: DeadLetterSettings = { maxDepth: 10000, retentionSeconds: 3600, messageBytes: 1024, replayEnabled: false, replayDelaySeconds: 5 };
export const DEFAULT_SCHEDULER: SchedulerSettings = { intervalSeconds: 5, startAfterSeconds: 0, batchSize: 1, maxConcurrentJobs: 10, requestBytes: 1024, responseBytes: 256 };
export const DEFAULT_WORKFLOW: WorkflowSettings = {
  publishServiceTimeMs: 5, maxConcurrentPublishes: 256, publishQueueLimit: 1000, messageBytes: 2048, maxDepth: 10000,
  transitionMs: 20, processingFailureShare: 0, maxAttempts: 3, retryDelayMs: 1000,
};

export type ServiceField = NumericSetting | { label: string; options: readonly { value: string; label: string }[]; help?: string }
  | { label: string; toggle: true; help?: string };
const n = (label: string, value: number, min: number, max: number, unit?: string, integer = false): NumericSetting => ({ label, value, min, max, unit, integer });
export const JOB_SERVICES: Record<JobKind, { label: string; description: string; fields: Record<string, ServiceField> }> = {
  workflow: {
    label: 'Workflow engine', description: 'Runs one job as a series of steps — charge the card, reserve the stock, send the email — and remembers where it got to. After each step it saves the job’s state, so a failed step is retried on its own instead of starting over. Connect a server to start workflows, then connect one worker per step; the order you draw the connections is the order of the steps. The server gets its answer as soon as the workflow is started, not when it finishes.',
    fields: {
      transitionMs: n('Time to save state between steps', 20, 0, 600000, 'ms'), processingFailureShare: n('Step failure share (0–1)', 0, 0, 1),
      maxAttempts: n('Attempts per step', 3, 1, 100, undefined, true), retryDelayMs: n('Wait before retrying a step', 1000, 0, 86400000, 'ms'),
      maxDepth: n('Waiting workflows per step', 10000, 0, 1000000, undefined, true), messageBytes: n('Workflow state size', 2048, 0, 100000000, 'bytes', true),
      publishServiceTimeMs: n('Time to start a workflow', 5, 0, 600000, 'ms'), maxConcurrentPublishes: n('Concurrent starts', 256, 1, 100000, undefined, true),
      publishQueueLimit: n('Start waiting queue limit', 1000, 0, 100000, undefined, true),
    },
  },
  eventStream: {
    label: 'Event stream', description: 'Keeps an event history. Each connected worker is an independent consumer group. Reading does not delete events; slow readers can fall behind retention. Connect a server to publish, and workers to read.',
    fields: {
      partitions: n('Partitions', 4, 1, 256, undefined, true), maxDepth: n('Maximum retained events', 10000, 1, 100000, undefined, true),
      retentionSeconds: n('Keep events for', 60, 0.001, 31536000, 's'), consumerStartSeconds: n('Start consumers after', 0, 0, 86400, 's'),
      startPosition: { label: 'When a consumer starts', options: [{ value: 'earliest', label: 'Read retained history' }, { value: 'latest', label: 'Read only new events' }] },
      publishServiceTimeMs: n('Time to accept an event', 1, 0, 600000, 'ms'), maxConcurrentPublishes: n('Concurrent publishes', 32, 1, 4096, undefined, true),
      publishQueueLimit: n('Publish waiting queue limit', 1000, 0, 100000, undefined, true), messageBytes: n('Event size', 1024, 0, 100000000, 'bytes', true),
    },
  },
  deadLetter: {
    label: 'Dead-letter queue', description: 'Holds jobs that exhausted the source queue’s retry allowance. Connect a Message Queue to it. A connected worker can replay these jobs when replay is enabled; failed replay stays failed instead of looping forever.',
    fields: {
      maxDepth: n('Maximum held jobs', 10000, 0, 100000, undefined, true), retentionSeconds: n('Keep failed jobs for', 3600, 0.001, 31536000, 's'),
      messageBytes: n('Replay message size', 1024, 0, 100000000, 'bytes', true),
      replayEnabled: { label: 'Replay to the connected worker', toggle: true }, replayDelaySeconds: n('Wait before replay', 5, 0, 86400, 's'),
    },
  },
  scheduler: {
    label: 'Scheduler', description: 'Starts background jobs at fixed intervals, such as a report every morning. Connect it directly to an Application Server or Function. Overlapping jobs are bounded; this model uses intervals rather than calendar cron expressions.',
    fields: {
      intervalSeconds: n('Run every', 5, 0.001, 31536000, 's'), startAfterSeconds: n('First run after', 0, 0, 86400, 's'),
      batchSize: n('Jobs per tick', 1, 1, 10000, undefined, true), maxConcurrentJobs: n('Maximum outstanding jobs', 10, 1, 100000, undefined, true),
      requestBytes: n('Job request size', 1024, 0, 100000000, 'bytes', true), responseBytes: n('Job acknowledgement size', 256, 0, 100000000, 'bytes', true),
    },
  },
};
