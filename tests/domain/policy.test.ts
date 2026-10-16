import { describe, expect, it } from 'vitest';
import { id, type ActorId, type BoardId, type StateId, type TaskId } from '@agentboard/shared';
import { Task, Workflow, canComment, evaluateTransition, type Role, type TransitionContext } from '@agentboard/domain';

const BOARD = id<BoardId>('b1');
const AGENT = id<ActorId>('agent-atlas');
const HUMAN = id<ActorId>('human-ada');
const S = {
  todo: id<StateId>('s-todo'),
  wip: id<StateId>('s-wip'),
  gate: id<StateId>('s-gate'),
  done: id<StateId>('s-done'),
};

const workflow = new Workflow({
  id: 'wf1',
  boardId: BOARD,
  name: 'Default',
  states: [
    { id: S.todo, name: 'To Do', category: 'todo', isHumanGate: false, wipLimit: null, order: 1 },
    { id: S.wip, name: 'In Progress', category: 'in_progress', isHumanGate: false, wipLimit: 2, order: 2 },
    { id: S.gate, name: 'Human Review', category: 'in_progress', isHumanGate: true, wipLimit: null, order: 3 },
    { id: S.done, name: 'Done', category: 'done', isHumanGate: false, wipLimit: null, order: 4 },
  ],
  transitions: [
    { id: 't1', from: S.todo, to: S.wip, name: 'start', allowedRoles: ['agent'], requiredFields: [] },
    { id: 't2', from: S.wip, to: S.gate, name: 'hand off', allowedRoles: ['agent', 'member'], requiredFields: ['acceptanceCriteria'] },
    { id: 't3', from: S.gate, to: S.done, name: 'approve', allowedRoles: ['admin'], requiredFields: [] },
  ],
});

function task(over: Partial<ConstructorParameters<typeof Task>[0]> = {}): Task {
  return new Task({
    id: id<TaskId>('t1'),
    boardId: BOARD,
    key: 'AG-1',
    title: 'do the thing',
    description: '',
    statusId: S.todo,
    priority: 'medium',
    assigneeId: null,
    reporterId: AGENT,
    labels: [],
    blockedBy: [],
    acceptanceCriteria: [],
    comments: [],
    lease: null,
    version: 1,
    createdAt: new Date('2026-10-15T12:00:00.000Z'),
    updatedAt: new Date('2026-10-15T12:00:00.000Z'),
    ...over,
  });
}

const agent = { id: AGENT, type: 'agent' as const, name: 'atlas', scopes: ['read', 'write', 'transition', 'comment'] as const };
const human = { id: HUMAN, type: 'human' as const, name: 'ada', scopes: ['read', 'write', 'transition', 'comment'] as const };

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  occupantsInTarget: [],
  openBlockers: [],
  role: 'agent',
  leaseHeldByActor: false,
  ...over,
});

describe('transition policy', () => {
  it('allows a defined transition for an allowed role', () => {
    const decision = evaluateTransition(task(), workflow, S.wip, agent, ctx());
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.value.id).toBe('t1');
  });

  it('refuses a transition that does not exist in the workflow graph', () => {
    const decision = evaluateTransition(task(), workflow, S.done, agent, ctx());
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('transition_not_allowed');
      expect(decision.error.details.allowed).toEqual([S.wip]);
    }
  });

  it('refuses a transition whose allowedRoles exclude the actor role', () => {
    const atGate = task({ statusId: S.gate });
    const decision = evaluateTransition(atGate, workflow, S.done, agent, ctx({ role: 'agent' }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('permission');
  });

  it('refuses a human-gate state for an agent but allows it for a human', () => {
    const atWip = task({ statusId: S.wip, acceptanceCriteria: ['ships green'] });

    const blocked = evaluateTransition(atWip, workflow, S.gate, agent, ctx({ role: 'agent' }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('human_gate');

    const allowed = evaluateTransition(atWip, workflow, S.gate, human, ctx({ role: 'member' }));
    expect(allowed.ok).toBe(true);
  });

  it('enforces required fields on the transition', () => {
    const atWip = task({ statusId: S.wip, acceptanceCriteria: [] });
    const decision = evaluateTransition(atWip, workflow, S.gate, agent, ctx());
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('validation');

    const filled = task({ statusId: S.wip, acceptanceCriteria: ['ships green'] });
    expect(evaluateTransition(filled, workflow, S.gate, agent, ctx()).ok).toBe(false);
    expect(evaluateTransition(filled, workflow, S.gate, human, ctx({ role: 'member' })).ok).toBe(true);
  });

  it('names the role failure when both the role and a required field fail', () => {
    // The point of the ordering: filling in the field would not help this caller, so the role is
    // the honest answer.
    const bothFail = task({ statusId: S.wip, acceptanceCriteria: [] });
    const decision = evaluateTransition(bothFail, workflow, S.gate, agent, ctx({ role: 'viewer' }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('permission');
  });

  it('enforces WIP limits and names the occupants', () => {
    const decision = evaluateTransition(task(), workflow, S.wip, agent, ctx({ occupantsInTarget: ['AG-2', 'AG-3'] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.error.code).toBe('wip_limit');
      expect(decision.error.details.occupants).toEqual(['AG-2', 'AG-3']);
    }
  });

  it('refuses to start a blocked task, unless the caller supplies an audited override', () => {
    const blocked = task({ blockedBy: [id<TaskId>('t9')] });
    const decision = evaluateTransition(blocked, workflow, S.wip, agent, ctx({ openBlockers: ['AG-9'] }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('blocked');

    const forced = evaluateTransition(blocked, workflow, S.wip, agent, ctx({ openBlockers: ['AG-9'], forceReason: 'blocker is informational' }));
    expect(forced.ok).toBe(true);
  });

  it('requires a live lease for an agent completing a task', () => {
    const atGate = task({ statusId: S.gate });
    const decision = evaluateTransition(atGate, workflow, S.done, agent, ctx({ role: 'admin' }));
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('lease_required');

    const leased = task({ statusId: S.gate, lease: { taskId: id<TaskId>('t1'), agentId: AGENT, acquiredAt: new Date('2026-10-15T12:00:00Z'), expiresAt: new Date('2026-10-15T12:15:00Z'), renewCount: 0 } });
    expect(evaluateTransition(leased, workflow, S.done, agent, ctx({ role: 'admin', leaseHeldByActor: true })).ok).toBe(true);
  });
});

describe('comment policy', () => {
  const now = new Date('2026-10-15T12:05:00.000Z');

  it('allows a plain note without a lease', () => {
    const decision = canComment(task(), agent, 'note', now);
    expect(decision.ok).toBe(true);
  });

  it('requires the lease holder to write a result comment', () => {
    const leasedByOther = task({
      lease: { taskId: id<TaskId>('t1'), agentId: HUMAN, acquiredAt: new Date('2026-10-15T12:00:00Z'), expiresAt: new Date('2026-10-15T12:15:00Z'), renewCount: 0 },
    });
    const decision = canComment(leasedByOther, agent, 'result', now);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('lease_required');
  });

  it('fails with an expired lease before anything else', () => {
    const expired = task({
      lease: { taskId: id<TaskId>('t1'), agentId: AGENT, acquiredAt: new Date('2026-10-15T11:00:00Z'), expiresAt: new Date('2026-10-15T11:30:00Z'), renewCount: 0 },
    });
    const decision = canComment(expired, agent, 'note', now);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.error.code).toBe('lease_expired');
  });
});
