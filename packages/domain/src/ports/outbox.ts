import type { RunId } from '@agentboard/shared';
import type { DomainEvent } from '../events.js';

/**
 * One row in the outbox. `id` is the identity a live consumer can resume from, and it is the
 * row's own id rather than a hash: the row is the thing the transaction actually wrote.
 */
export interface OutboxRow {
  id: string;
  event: DomainEvent;
  runId: RunId | null;
}

/**
 * `drain` is not something the domain needs — the domain only writes inside the transaction.
 * It belongs on this port because the outbox is one object: the rows written in the same
 * transaction as the aggregate are exactly the rows a dispatcher reads after commit.
 *
 * A live stream fed by an in-process hook instead would report events whose transaction later
 * rolled back, and the board would show a card that does not exist. Reading the outbox is the
 * only way a stream can promise that what it says happened, happened.
 */
export interface OutboxReader {
  drain(limit?: number): Promise<OutboxRow[]>;
}
