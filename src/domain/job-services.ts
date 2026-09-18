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
export type EventStreamNode = NodeBase & { kind: 'eventStream'; settings: EventStreamSettings };
export type DeadLetterNode = NodeBase & { kind: 'deadLetter'; settings: DeadLetterSettings };
export type SchedulerNode = NodeBase & { kind: 'scheduler'; settings: SchedulerSettings };
export type JobServiceNode = EventStreamNode | DeadLetterNode | SchedulerNode;
export type JobKind = JobServiceNode['kind'];
export const JOB_KINDS = ['eventStream', 'deadLetter', 'scheduler'] as const;
export const isJobKind = (kind: string): kind is JobKind => (JOB_KINDS as readonly string[]).includes(kind);

export const DEFAULT_EVENT_STREAM: EventStreamSettings = {
  partitions: 4, maxDepth: 10000, retentionSeconds: 60, consumerStartSeconds: 0, startPosition: 'earliest',
  publishServiceTimeMs: 1, maxConcurrentPublishes: 32, publishQueueLimit: 1000, messageBytes: 1024,
};
export const DEFAULT_DEAD_LETTER: DeadLetterSettings = { maxDepth: 10000, retentionSeconds: 3600, messageBytes: 1024, replayEnabled: false, replayDelaySeconds: 5 };
export const DEFAULT_SCHEDULER: SchedulerSettings = { intervalSeconds: 5, startAfterSeconds: 0, batchSize: 1, maxConcurrentJobs: 10, requestBytes: 1024, responseBytes: 256 };

export type ServiceField = NumericSetting | { label: string; options: readonly { value: string; label: string }[]; help?: string }
  | { label: string; toggle: true; help?: string };
const n = (label: string, value: number, min: number, max: number, unit?: string, integer = false): NumericSetting => ({ label, value, min, max, unit, integer });
export const JOB_SERVICES: Record<JobKind, { label: string; description: string; fields: Record<string, ServiceField> }> = {
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
