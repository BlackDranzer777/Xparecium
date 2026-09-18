/**
 * A one-way transmission channel.
 *
 * Every connection you draw becomes two channels, one per direction, because
 * a request going out and a response coming back do not share a queue.
 *
 * The model is deliberately simple and is documented as such: a message starts
 * transmitting when the link is free, occupies the link for
 * (bytes x 8) / bandwidth, and then takes the one-way propagation delay to
 * arrive. There is no congestion control, no packet loss, no windowing and no
 * per-packet behaviour. It reproduces "a big response on a thin link is slow",
 * not TCP or QUIC.
 */
import type { PendingMessage } from './queue';
import { TimeWeightedAccumulator } from '../metrics';
import { RingQueue } from '../ring-queue';
import { transmissionMs } from '../../domain/units';

export type MessageKind =
  | 'request'
  | 'response'
  | 'cacheLookup'
  | 'cacheResult'
  | 'dbQuery'
  | 'dbResult'
  | 'cachePopulate'
  | 'cachePopulateAck'
  | 'queuePublish'
  | 'queueAck'
  | 'dnsQuery'
  | 'dnsAnswer'
  | 'replicaQuery'
  /** Primary -> replica: a write to apply. Carries no waiting request. */
  | 'replicate'
  | 'kvOp'
  | 'kvResult'
  | 'storageOp'
  | 'storageResult'
  | 'topicPublish'
  | 'topicAck'
  | 'dataOp'
  | 'dataResult' | 'streamPublish' | 'streamAck' | 'deadLetter' | 'supportCall' | 'supportReply' | 'supportDetached' | 'supportAck' | 'heartbeat';

export interface LinkMessage {
  job?: PendingMessage;
  failure?: string;
  requestId: number;
  kind: MessageKind;
  bytes: number;
  queuedAt: number;
}

export class LinkChannel {
  readonly key: string;
  readonly edgeId: string;
  readonly fromId: string;
  readonly toId: string;
  readonly bandwidthMbps: number;
  readonly propagationDelayMs: number;

  readonly queue = new RingQueue<LinkMessage>();
  inFlight: LinkMessage | null = null;

  readonly busyAcc = new TimeWeightedAccumulator(0);
  readonly queueAcc = new TimeWeightedAccumulator(0);

  messages = 0;
  bytes = 0;
  transmissionMsTotal = 0;
  waitMsTotal = 0;

  constructor(params: {
    key: string;
    edgeId: string;
    fromId: string;
    toId: string;
    bandwidthMbps: number;
    propagationDelayMs: number;
  }) {
    this.key = params.key;
    this.edgeId = params.edgeId;
    this.fromId = params.fromId;
    this.toId = params.toId;
    this.bandwidthMbps = params.bandwidthMbps;
    this.propagationDelayMs = params.propagationDelayMs;
  }

  enqueue(message: LinkMessage, now: number): void {
    this.queue.push(message);
    this.queueAcc.set(now, this.queue.length);
  }

  /**
   * Start the next message if the link is idle.
   * Returns the transmission duration and the message, or null if nothing started.
   */
  startNext(now: number): { message: LinkMessage; durationMs: number } | null {
    if (this.inFlight !== null) return null;
    const message = this.queue.shift();
    if (!message) return null;
    this.queueAcc.set(now, this.queue.length);
    this.waitMsTotal += now - message.queuedAt;
    this.inFlight = message;
    this.busyAcc.set(now, 1);
    const durationMs = transmissionMs(message.bytes, this.bandwidthMbps);
    this.transmissionMsTotal += durationMs;
    this.messages += 1;
    this.bytes += message.bytes;
    return { message, durationMs };
  }

  finishTransmission(now: number): LinkMessage | null {
    const message = this.inFlight;
    this.inFlight = null;
    this.busyAcc.set(now, 0);
    return message;
  }
}
