import type { BoardId, TaskId } from '@agentboard/shared';
import type { ActivityEvent, ActivityRepository, Tx } from '@agentboard/domain';
import type { PoolClient } from 'pg';
import type { ActivityRow } from './mapper.js';
import { activityFromRow } from './mapper.js';
import { clientOf } from './tx.js';

export class PgActivityRepository implements ActivityRepository {
  async append(tx: Tx, event: ActivityEvent): Promise<void> {
    const client = clientOf(tx);
    await client.query(
      `insert into activity_events (id, board_id, task_id, actor_id, run_id, type, at, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event.id, event.boardId, event.taskId, event.actorId, event.runId, event.type, event.at, event.payload],
    );
  }

  async readForTask(tx: Tx, taskId: TaskId, limit: number): Promise<ActivityEvent[]> {
    const client = clientOf(tx);
    const res = await client.query<ActivityRow>(
      `select id, board_id, task_id, actor_id, run_id, type, at, payload
         from activity_events where task_id = $1 order by at, id limit $2`,
      [taskId, limit],
    );
    return res.rows.map(activityFromRow);
  }

  async readForBoard(tx: Tx, boardId: BoardId, limit: number): Promise<ActivityEvent[]> {
    const client = clientOf(tx);
    const res = await client.query<ActivityRow>(
      `select id, board_id, task_id, actor_id, run_id, type, at, payload
         from activity_events where board_id = $1 order by at, id limit $2`,
      [boardId, limit],
    );
    return res.rows.map(activityFromRow);
  }
}
