import type {
  ActivityEvent,
  ActivityRepository,
  DomainEvent,
  EventPublisher,
  OutboxReader,
  OutboxRow,
  Tx,
} from '@agentboard/domain';
import type { BoardId, RunId, TaskId } from '@agentboard/shared';

export class InMemoryActivityRepository implements ActivityRepository {
  private rows: ActivityEvent[] = [];

  async append(_tx: Tx, event: ActivityEvent): Promise<void> {
    this.rows.push(event);
  }

  async readForTask(_tx: Tx, taskId: TaskId, limit: number): Promise<ActivityEvent[]> {
    return this.rows.filter((r) => r.taskId === taskId).slice(0, limit);
  }

  async readForBoard(_tx: Tx, boardId: BoardId, limit: number): Promise<ActivityEvent[]> {
    return this.rows.filter((r) => r.boardId === boardId).slice(0, limit);
  }

  all(): ActivityEvent[] {
    return [...this.rows];
  }
}

/**
 * Stands in for the Postgres outbox: same transaction, drained after commit.
 *
 * The row id here is a local counter, not a database key — the fake has no row to name. That is
 * the only difference from Postgres, and it is why the stream test asserts the *shape* of a row
 * rather than the value of its id.
 */
export class InMemoryEventPublisher implements EventPublisher, OutboxReader {
  private outbox: OutboxRow[] = [];

  async publish(_tx: Tx, event: DomainEvent, runId: RunId | null): Promise<void> {
    this.outbox.push({ id: `outbox-${this.outbox.length + 1}`, event, runId });
  }

  async drain(limit = 100): Promise<OutboxRow[]> {
    const rows = this.outbox.slice(0, limit);
    this.outbox = this.outbox.slice(limit);
    return rows;
  }
}
