import type { ActorId, BoardId, RunId, TaskId } from '@agentboard/shared';
import { id } from '@agentboard/shared';
import type { DomainEvent, EventPublisher, OutboxReader, OutboxRow, Tx } from '@agentboard/domain';
import type { Pool } from 'pg';
import { clientOf } from './tx.js';

/**
 * The outbox is written inside the same transaction as the aggregate, so an event that survived
 * the commit is an event the aggregate really produced. Dispatch happens after commit, on a
 * separate connection — never inside the unit of work.
 */
export class PgEventPublisher implements EventPublisher, OutboxReader {
  constructor(private readonly pool: Pool) {}

  async publish(tx: Tx, event: DomainEvent, runId: RunId | null): Promise<void> {
    const client = clientOf(tx);
    await client.query(
      `insert into outbox_events (aggregate_id, board_id, actor_id, run_id, type, at, payload)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [event.aggregateId, event.boardId, event.actorId, runId, event.type, event.at, event.payload],
    );
  }

  /** SKIP LOCKED keeps two dispatchers from claiming the same row. */
  async drain(limit = 100): Promise<OutboxRow[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query<{
        id: string;
        aggregate_id: string;
        board_id: string;
        actor_id: string;
        run_id: string | null;
        type: string;
        at: Date;
        payload: Record<string, unknown>;
      }>(
        `select id, aggregate_id, board_id, actor_id, run_id, type, at, payload
           from outbox_events
          where dispatched_at is null
          order by at, id
          limit $1
          for update skip locked`,
        [limit],
      );

      if (res.rows.length > 0) {
        await client.query('update outbox_events set dispatched_at = now() where id = ANY($1::text[])', [
          res.rows.map((r) => r.id),
        ]);
      }

      return res.rows.map((row) => ({
        id: row.id,
        event: {
          type: row.type as DomainEvent['type'],
          aggregateId: id<TaskId>(row.aggregate_id),
          boardId: id<BoardId>(row.board_id),
          actorId: id<ActorId>(row.actor_id),
          at: row.at,
          payload: row.payload,
        },
        runId: row.run_id ? id<RunId>(row.run_id) : null,
      }));
    } finally {
      client.release();
    }
  }

  async pendingCount(): Promise<number> {
    const res = await this.pool.query('select count(*) as count from outbox_events where dispatched_at is null');
    return Number(res.rows[0]?.count ?? 0);
  }
}
