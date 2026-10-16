import type { BoardId, TaskId, RunId } from '@agentboard/shared';
import type { ActivityEvent } from '../model/activity.js';
import type { DomainEvent } from '../events.js';
import type { Tx } from './unitOfWork.js';

export interface ActivityRepository {
  append(tx: Tx, event: ActivityEvent): Promise<void>;
  readForTask(tx: Tx, taskId: TaskId, limit: number): Promise<ActivityEvent[]>;
  readForBoard(tx: Tx, boardId: BoardId, limit: number): Promise<ActivityEvent[]>;
}

/**
 * Written inside the same transaction as the aggregate change. A dispatcher drains the
 * outbox after commit, which is what keeps the audit log and the live board in agreement.
 */
export interface EventPublisher {
  publish(tx: Tx, event: DomainEvent, runId: RunId | null): Promise<void>;
}
