import { describe, expect, it } from 'vitest';
import { id, type ActorId } from '@agentboard/shared';
import { harness, unwrap, BOARD, AGENT, HUMAN, STATES } from '../harness.js';

const SECOND_AGENT = id<ActorId>('agent-vega');

describe('use cases against in-memory ports', () => {
  it('creates a task with a board-scoped key and lands in the audit log and the outbox', async () => {
    const h = await harness();
    const task = unwrap(
      await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'triage inbox', description: 'scan the queue' }),
    );

    expect(task.key).toBe('AG-1');
    expect(task.statusId).toBe(STATES.todo);

    const audit = h.activity.all();
    expect(audit.map((a) => a.type)).toEqual(['TaskCreated']);
    expect((await h.publisher.drain())[0]?.event.type).toBe('TaskCreated');
  });

  it('claims a task, takes the guarded start transition, and records every event', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'implement retry' }));

    const claimed = unwrap(
      await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, autoStart: true, reason: 'picking up' }),
    );

    expect(claimed.statusId).toBe(STATES.inProgress);
    expect(claimed.assigneeId).toBe(AGENT);
    expect(claimed.lease?.agentId).toBe(AGENT);

    const types = h.activity.all().map((a) => a.type);
    expect(types).toContain('LeaseAcquired');
    expect(types).toContain('TaskAssigned');
    expect(types).toContain('TaskMoved');
  });

  it('refuses a second claim while another agent holds a live lease', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'one owner only' }));
    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id });

    const vegaToken = await h.resolver.register({
      id: SECOND_AGENT,
      type: 'agent',
      name: 'vega',
      scopes: ['read', 'write', 'transition', 'comment'],
    });

    const conflict = await h.app.claimTask.execute({ ...h.ctx(vegaToken), taskId: task.id });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('conflict');
      expect(conflict.error.details.holder).toBe(AGENT);
    }
  });

  it('enforces required fields before the role gate, then the human gate', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'needs criteria' }));
    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, autoStart: true });

    const denied = await h.app.moveTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, toStateId: STATES.review, reason: 'done coding' });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('validation');

    await h.app.updateTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, acceptanceCriteria: ['tests green'] });

    const gate = await h.app.moveTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, toStateId: STATES.review, reason: 'done coding' });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error.code).toBe('human_gate');

    const byHuman = await h.app.moveTask.execute({ ...h.ctx(h.humanToken), taskId: task.id, toStateId: STATES.review, reason: 'ready' });
    expect(byHuman.ok).toBe(true);
  });

  it('lets a human cross the human gate and approve to done', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'ship it' }));
    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, autoStart: true });
    await h.app.updateTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, acceptanceCriteria: ['tests green'] });

    const handedOff = await h.app.moveTask.execute({ ...h.ctx(h.humanToken), taskId: task.id, toStateId: STATES.review, reason: 'ready for review' });
    expect(handedOff.ok).toBe(true);

    const approved = await h.app.moveTask.execute({ ...h.ctx(h.humanToken), taskId: task.id, toStateId: STATES.done, reason: 'looks right' });
    expect(approved.ok).toBe(true);
    expect(h.activity.all().map((a) => a.type)).toContain('TaskMoved');
  });

  it('enforces WIP limits on entry and names the occupants', async () => {
    const h = await harness();
    for (let i = 0; i < 2; i += 1) {
      const t = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: `filler ${i}` }));
      await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: t.id, autoStart: true });
    }

    const third = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'third' }));
    const decision = await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: third.id, autoStart: true });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('wip_limit');
      expect((decision.error.details.occupants as string[]).length).toBe(2);
    }
  });

  it('refuses to start a blocked task unless the override is audited', async () => {
    const h = await harness();
    const blocker = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'blocker' }));
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'blocked' }));

    await h.app.setBlockedBy.execute({ ...h.ctx(h.agentToken), taskId: task.id, blockers: [blocker.id] });

    const denied = await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, autoStart: true });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('blocked');

    const forced = await h.app.moveTask.execute({
      ...h.ctx(h.agentToken),
      taskId: task.id,
      toStateId: STATES.inProgress,
      reason: 'blocker is informational',
      forceReason: 'blocker documents intent, not a live dependency',
    });
    expect(forced.ok).toBe(true);
    const audited = h.activity.all().find((a) => a.type === 'TaskMoved');
    expect(audited?.payload.forceReason).toBe('blocker documents intent, not a live dependency');
  });

  it('refuses a dependency cycle', async () => {
    const h = await harness();
    const a = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'a' }));
    const b = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'b' }));

    await h.app.setBlockedBy.execute({ ...h.ctx(h.agentToken), taskId: a.id, blockers: [b.id] });
    const cycle = await h.app.setBlockedBy.execute({ ...h.ctx(h.agentToken), taskId: b.id, blockers: [a.id] });

    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.code).toBe('cycle');
  });

  it('only the lease holder can write a result comment', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'result test' }));

    const early = await h.app.addComment.execute({ ...h.ctx(h.agentToken), taskId: task.id, kind: 'result', body: 'premature' });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe('lease_required');

    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id });
    const result = await h.app.addComment.execute({ ...h.ctx(h.agentToken), taskId: task.id, kind: 'result', body: 'shipped' });
    expect(result.ok).toBe(true);
  });

  it('fails a renew after the lease expires', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'long run' }));
    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id });

    h.clock.advance(16 * 60 * 1000);
    const renew = await h.app.renewLease.execute({ ...h.ctx(h.agentToken), taskId: task.id });
    expect(renew.ok).toBe(false);
    if (!renew.ok) expect(renew.error.code).toBe('lease_expired');
  });

  it('escalates to a human and hands over assignment', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'stuck' }));

    const escalated = unwrap(
      await h.app.escalate.execute({ ...h.ctx(h.agentToken), taskId: task.id, humanActorId: HUMAN, note: 'need a product decision on retry policy' }),
    );

    expect(escalated.assigneeId).toBe(HUMAN);
    expect(escalated.comments[0]?.kind).toBe('escalation');
  });

  it('compare-and-set refuses a stale write', async () => {
    const h = await harness();
    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'contended' }));

    const tx = await h.deps.uow.run(async (t) => t);
    const stale = await h.deps.tasks.findById(tx, task.id);
    if (!stale) throw new Error('missing task');

    await h.app.updateTask.execute({ ...h.ctx(h.agentToken), taskId: task.id, title: 'winner' });

    stale.title = 'loser';
    await expect(h.deps.tasks.save(tx, stale)).rejects.toMatchObject({ code: 'concurrency' });
  });

  it('board snapshot groups tasks by workflow state', async () => {
    const h = await harness();
    const t1 = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'snapshot me' }));
    await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: t1.id, autoStart: true });

    const snapshot = unwrap(await h.app.getBoardSnapshot.execute({ ...h.ctx(h.agentToken), boardId: BOARD }));
    expect(snapshot.columns.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Human Review', 'Done']);
    expect(snapshot.columns[1]?.count).toBe(1);
  });

  it('whoAmI reports the resolved actor and its board role', async () => {
    const h = await harness();
    const me = unwrap(await h.app.whoAmI.execute(h.ctx(h.agentToken)));
    expect(me.actor).toMatchObject({ id: AGENT, type: 'agent' });
    expect((me.boards as Array<{ role: string }>)[0]?.role).toBe('agent');
  });
});
