import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MemoryUnitOfWork } from '@agentboard/infra';
import { ConcurrencyError, id, type TaskId } from '@agentboard/shared';
import * as F from '../fixtures.js';
import { unwrap } from '../harness.js';
import { pgHarness, startPostgres, type PgHarness } from './pgHarness.js';

const runtime = await startPostgres();
if (!runtime) {
  console.warn('Postgres integration tests skipped: DATABASE_URL is unset and Docker is unavailable.');
}

const pg = runtime ? describe : describe.skip;

pg('Postgres adapters', () => {
  let h!: PgHarness;

  beforeAll(async () => {
    if (!runtime) return;
    h = await pgHarness(runtime);
  });

  afterAll(async () => {
    if (runtime) await runtime.stop();
  });

  async function activityCount(taskId: string): Promise<number> {
    const res = await h.pool.query('select count(*) as count from activity_events where task_id = $1', [taskId]);
    return Number(res.rows[0]?.count ?? 0);
  }

  async function sequenceValue(): Promise<number> {
    const res = await h.pool.query('select next_value as next_value from task_key_sequences where board_slug = $1', [
      F.BOARD_SLUG,
    ]);
    return Number(res.rows[0]?.next_value ?? 0);
  }

  // The clock advances so `created_at` ordering is deterministic; a fixed clock would make rows
  // tie and the cursor test would depend on string ordering of ids.
  async function create(title: string) {
    h.clock.advance(1000);
    return h.app.createTask.execute({ ...h.ctx(F.AGENT_TOKEN), boardId: F.BOARD, title });
  }

  it('commits the aggregate, the audit row and the outbox row together', async () => {
    const created = unwrap(await create('Atomic write'));
    const activityBefore = await activityCount(created.id);
    const outboxBefore = await h.publisher.pendingCount();

    const failure = await h.deps
      .uow.run(async (tx) => {
        const task = await h.deps.tasks.findById(tx, created.id);
        if (!task) throw new Error('task disappeared mid-transaction');

        task.title = 'This must not survive';
        await h.deps.tasks.save(tx, task);
        await h.deps.activity.append(tx, {
          id: 'probe-activity',
          boardId: F.BOARD,
          taskId: created.id,
          actorId: F.AGENT,
          runId: null,
          type: 'TaskUpdated',
          at: h.clock.now(),
          payload: {},
        });
        throw new Error('boom');
      })
      .catch((error) => error as Error);

    expect(failure.message).toBe('boom');

    const after = await h.deps.uow.run((tx) => h.deps.tasks.findById(tx, created.id));
    expect(after?.title).toBe('Atomic write');
    expect(await activityCount(created.id)).toBe(activityBefore);
    expect(await h.publisher.pendingCount()).toBe(outboxBefore);
  });

  it('compare-and-set rejects a write made against a stale version', async () => {
    const created = unwrap(await create('Concurrent edit'));

    const stale = await h.deps.uow.run(async (tx) => {
      const task = await h.deps.tasks.findById(tx, created.id);
      if (!task) throw new Error('not found');
      return task;
    });

    await h.deps.uow.run(async (tx) => {
      const task = await h.deps.tasks.findById(tx, created.id);
      if (!task) throw new Error('not found');
      task.title = 'Winner';
      await h.deps.tasks.save(tx, task);
    });

    const error = await h.deps
      .uow.run(async (tx) => {
        await h.deps.tasks.save(tx, stale);
        return null;
      })
      .catch((e) => e as Error);

    expect(error).toBeInstanceOf(ConcurrencyError);
    expect((error as ConcurrencyError).details).toMatchObject({
      taskId: created.id,
      expectedVersion: stale.version,
      actualVersion: stale.version + 1,
    });

    const winner = await h.deps.uow.run((tx) => h.deps.tasks.findById(tx, created.id));
    expect(winner?.title).toBe('Winner');
  });

  it('the outbox is drained after commit, on a separate connection', async () => {
    const pendingBefore = await h.publisher.pendingCount();
    const created = unwrap(await create('Outbox drain'));

    expect(await h.publisher.pendingCount()).toBe(pendingBefore + 1);

    const drained = await h.publisher.drain(100);
    expect(drained.map((row) => row.event.aggregateId)).toContain(created.id);
    expect(await h.publisher.pendingCount()).toBe(0);
  });

  it('append-only is enforced by the database, not by convention', async () => {
    const created = unwrap(await create('Immutable audit trail'));

    await h.deps.uow.run((tx) =>
      h.deps.activity.append(tx, {
        id: 'probe-append-only',
        boardId: F.BOARD,
        taskId: created.id,
        actorId: F.AGENT,
        runId: null,
        type: 'TaskCreated',
        at: h.clock.now(),
        payload: {},
      }),
    );

    await expect(h.pool.query('update activity_events set payload = $1 where id = $2', ['{}', 'probe-append-only'])).rejects.toThrow(
      /append-only/,
    );
    await expect(h.pool.query('delete from activity_events where id = $1', ['probe-append-only'])).rejects.toThrow(
      /append-only/,
    );
  });

  it('a rolled-back key is not burned', async () => {
    const first = unwrap(await create('Key one'));
    const before = await sequenceValue();

    await expect(
      h.deps.uow.run(async (tx) => {
        const next = await h.deps.keys.next(tx, F.BOARD_SLUG);
        expect(next).toBe(before + 1);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect(await sequenceValue()).toBe(before);

    const second = unwrap(await create('Key two'));
    expect(second.key).toBe(`${F.BOARD_SLUG}-${before + 1}`);
    expect(first.key).toBe(`${F.BOARD_SLUG}-${before}`);
  });

  it('occupantsInState excludes the task being moved', async () => {
    const first = unwrap(await create('WIP one'));
    const second = unwrap(await create('WIP two'));

    for (const task of [first, second]) {
      unwrap(await h.app.claimTask.execute({ ...h.ctx(F.AGENT_TOKEN), taskId: task.id, autoStart: true, reason: 'start' }));
    }

    const third = unwrap(await create('WIP three'));
    const result = await h.app.moveTask.execute({
      ...h.ctx(F.AGENT_TOKEN),
      taskId: third.id,
      toStateId: F.STATES.inProgress,
      reason: 'start',
    });

    if (result.ok) throw new Error('expected the WIP limit to reject the move');
    expect(result.error.code).toBe('wip_limit');
    expect(result.error.details.occupants).toEqual([first.key, second.key]);

    const occupants = await h.deps.uow.run((tx) =>
      h.deps.tasks.occupantsInState(tx, F.BOARD, F.STATES.inProgress, third.id),
    );
    expect(occupants).toEqual([first.key, second.key]);

    const excludingFirst = await h.deps.uow.run((tx) =>
      h.deps.tasks.occupantsInState(tx, F.BOARD, F.STATES.inProgress, first.id),
    );
    expect(excludingFirst).toEqual([second.key]);
  });

  it('filters and paginates without loading the whole board', async () => {
    const titles = ['Filter alpha', 'Filter beta', 'Filter gamma'];
    const created: string[] = [];
    for (const title of titles) {
      const task = unwrap(await h.app.createTask.execute({ ...h.ctx(F.AGENT_TOKEN), boardId: F.BOARD, title, labels: ['filter-test'] }));
      created.push(task.key);
    }

    const pageOne = await h.deps.uow.run((tx) => h.deps.tasks.query(tx, { boardId: F.BOARD, label: 'filter-test', limit: 2 }));
    expect(pageOne.items.map((t) => t.key)).toEqual(created.slice(0, 2));
    expect(pageOne.cursor).toBe('2');

    const pageTwo = await h.deps.uow.run((tx) =>
      h.deps.tasks.query(tx, { boardId: F.BOARD, label: 'filter-test', limit: 2, cursor: pageOne.cursor }),
    );
    expect(pageTwo.items.map((t) => t.key)).toEqual([created[2]]);
    expect(pageTwo.cursor).toBeNull();

    const blockedOnly = await h.deps.uow.run((tx) =>
      h.deps.tasks.query(tx, { boardId: F.BOARD, label: 'filter-test', onlyBlocked: true }),
    );
    expect(blockedOnly.items).toHaveLength(0);
  });

  it('the aggregate round-trips comments, blockers and the lease', async () => {
    const blocker = unwrap(await create('Blocker'));
    const task = unwrap(
      await h.app.createTask.execute({ ...h.ctx(F.AGENT_TOKEN), boardId: F.BOARD, title: 'Round trip', blockedBy: [blocker.id] }),
    );

    unwrap(await h.app.addComment.execute({ ...h.ctx(F.AGENT_TOKEN), taskId: task.id, kind: 'note', body: 'first note' }));
    unwrap(await h.app.claimTask.execute({ ...h.ctx(F.AGENT_TOKEN), taskId: task.id, reason: 'claim' }));

    const loaded = await h.deps.uow.run((tx) => h.deps.tasks.findById(tx, task.id));
    expect(loaded?.blockedBy).toEqual([blocker.id]);
    expect(loaded?.comments.map((c) => c.body)).toEqual(['first note']);
    expect(loaded?.lease?.agentId).toBe(F.AGENT);

    unwrap(await h.app.releaseTask.execute({ ...h.ctx(F.AGENT_TOKEN), taskId: task.id }));

    const released = await h.deps.uow.run((tx) => h.deps.tasks.findById(tx, task.id));
    expect(released?.lease).toBeNull();
  });

  it('refuses a transaction that did not come from PgUnitOfWork', async () => {
    const foreignTx = await new MemoryUnitOfWork().run(async (tx) => tx);
    await expect(h.deps.tasks.findById(foreignTx, id<TaskId>('some-task'))).rejects.toThrow(/non-Postgres transaction/);
  });

  it('the migration runner is idempotent', async () => {
    const reapplied = await migrate(h.pool);
    expect(reapplied).toHaveLength(0);

    const rows = await h.pool.query('select file from schema_migrations order by file');
    expect(rows.rows.map((r) => r.file)).toEqual(['001_initial.sql']);
  });
});
