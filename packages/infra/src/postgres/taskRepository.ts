import type { BoardId, StateId, TaskId } from '@agentboard/shared';
import { ConcurrencyError } from '@agentboard/shared';
import type { Page, Task, TaskFilter, TaskRepository, Tx } from '@agentboard/domain';
import type { PoolClient } from 'pg';
import type { CommentRow, LeaseRow, TaskRow } from './mapper.js';
import { taskFromRow } from './mapper.js';
import { clientOf } from './tx.js';

const TASK_COLUMNS =
  'id, board_id, key, title, description, status_id, priority, assignee_id, reporter_id, ' +
  'labels, acceptance_criteria, version, created_at, updated_at';

/**
 * The aggregate is the unit of persistence: loading a Task means loading its comments, blockers
 * and lease, and saving a Task writes them as a set. Callers never see a row.
 */
export class PgTaskRepository implements TaskRepository {
  async findById(tx: Tx, taskId: TaskId): Promise<Task | null> {
    const client = clientOf(tx);
    const res = await client.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where id = $1`,
      [taskId],
    );
    const row = res.rows[0];
    return row ? await loadAggregate(client, row) : null;
  }

  async findMany(tx: Tx, ids: readonly TaskId[]): Promise<Task[]> {
    if (ids.length === 0) return [];
    const client = clientOf(tx);
    const res = await client.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where id = ANY($1::text[])`,
      [[...ids]],
    );
    return Promise.all(res.rows.map((row) => loadAggregate(client, row)));
  }

  async query(tx: Tx, filter: TaskFilter): Promise<Page<Task>> {
    const client = clientOf(tx);
    const limit = filter.limit ?? 50;
    const offset = filter.cursor ? Number(filter.cursor) : 0;

    const params: unknown[] = [filter.boardId];
    const where: string[] = ['board_id = $1'];

    if (filter.statusId) {
      params.push(filter.statusId);
      where.push(`status_id = $${params.length}`);
    }
    if (filter.assigneeId) {
      params.push(filter.assigneeId);
      where.push(`assignee_id = $${params.length}`);
    }
    if (filter.label) {
      params.push(filter.label);
      where.push(`$${params.length} = ANY(labels)`);
    }
    if (filter.onlyBlocked) {
      where.push('exists (select 1 from task_blockers tb where tb.task_id = tasks.id)');
    }
    if (filter.query) {
      params.push(`%${filter.query.toLowerCase()}%`);
      const p = params.length;
      where.push(`(lower(title) like $${p} or lower(description) like $${p})`);
    }

    params.push(limit);
    const limitParam = params.length;
    params.push(offset);
    const offsetParam = params.length;

    const res = await client.query<TaskRow>(
      `select ${TASK_COLUMNS} from tasks where ${where.join(' and ')} ` +
        `order by created_at, id limit $${limitParam} offset $${offsetParam}`,
      params,
    );

    const items = await Promise.all(res.rows.map((row) => loadAggregate(client, row)));
    // A full page is the only signal that more rows exist; the cursor stays an opaque offset.
    const cursor = items.length === limit ? String(offset + limit) : null;

    return { items, cursor };
  }

  async occupantsInState(tx: Tx, boardId: BoardId, stateId: StateId, excludeTaskId?: TaskId): Promise<string[]> {
    const client = clientOf(tx);
    const params: unknown[] = [boardId, stateId];
    const exclude = excludeTaskId ? ` and id <> $3` : '';
    const res = await client.query<{ key: string }>(
      `select key from tasks where board_id = $1 and status_id = $2${exclude} order by created_at, id`,
      excludeTaskId ? [boardId, stateId, excludeTaskId] : params,
    );
    return res.rows.map((r) => r.key);
  }

  /** Compare-and-set. The version the aggregate was loaded at is part of the WHERE clause. */
  async save(tx: Tx, task: Task): Promise<void> {
    const client = clientOf(tx);

    const updated = await client.query<{ version: number }>(
      `update tasks
          set title = $2, description = $3, status_id = $4, priority = $5,
              assignee_id = $6, labels = $7, acceptance_criteria = $8,
              updated_at = $9, version = version + 1
        where id = $1 and version = $10
        returning version`,
      [
        task.id,
        task.title,
        task.description,
        task.statusId,
        task.priority,
        task.assigneeId,
        task.labels,
        task.acceptanceCriteria,
        task.updatedAt,
        task.version,
      ],
    );

    const row = updated.rows[0];
    if (!row) {
      const current = await client.query<{ version: number }>('select version from tasks where id = $1', [task.id]);
      const existing = current.rows[0];
      if (!existing) {
        await insertTask(client, task);
        await saveChildren(client, task);
        return;
      }
      throw new ConcurrencyError(task.id, task.version, Number(existing.version));
    }

    task.version = Number(row.version);
    await saveChildren(client, task);
  }
}

async function loadAggregate(client: PoolClient, row: TaskRow): Promise<Task> {
  const comments = await client.query<CommentRow>(
    `select id, task_id, author_id, kind, body, run_id, created_at from comments where task_id = $1 order by created_at, id`,
    [row.id],
  );
  const blockers = await client.query<{ blocked_by_task_id: string }>(
    'select blocked_by_task_id from task_blockers where task_id = $1 order by blocked_by_task_id',
    [row.id],
  );
  const lease = await client.query<LeaseRow>(
    'select task_id, agent_id, acquired_at, expires_at, renew_count from leases where task_id = $1',
    [row.id],
  );

  return taskFromRow(
    row,
    comments.rows,
    blockers.rows.map((b) => b.blocked_by_task_id),
    lease.rows[0] ?? null,
  );
}

async function insertTask(client: PoolClient, task: Task): Promise<void> {
  await client.query(
    `insert into tasks (
       id, board_id, key, title, description, status_id, priority,
       assignee_id, reporter_id, labels, acceptance_criteria, version, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      task.id,
      task.boardId,
      task.key,
      task.title,
      task.description,
      task.statusId,
      task.priority,
      task.assigneeId,
      task.reporterId,
      task.labels,
      task.acceptanceCriteria,
      task.version,
      task.createdAt,
      task.updatedAt,
    ],
  );
}

async function saveChildren(client: PoolClient, task: Task): Promise<void> {
  for (const comment of task.comments) {
    await client.query(
      `insert into comments (id, task_id, author_id, kind, body, run_id, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [comment.id, comment.taskId, comment.authorId, comment.kind, comment.body, comment.runId, comment.createdAt],
    );
  }

  await client.query('delete from task_blockers where task_id = $1', [task.id]);
  for (const blocker of task.blockedBy) {
    await client.query(
      'insert into task_blockers (task_id, blocked_by_task_id) values ($1, $2)',
      [task.id, blocker],
    );
  }

  if (task.lease) {
    await client.query(
      `insert into leases (task_id, agent_id, acquired_at, expires_at, renew_count)
       values ($1, $2, $3, $4, $5)
       on conflict (task_id) do update
         set agent_id = excluded.agent_id,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at,
             renew_count = excluded.renew_count`,
      [task.lease.taskId, task.lease.agentId, task.lease.acquiredAt, task.lease.expiresAt, task.lease.renewCount],
    );
  } else {
    await client.query('delete from leases where task_id = $1', [task.id]);
  }
}
