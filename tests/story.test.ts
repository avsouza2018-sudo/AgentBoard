import { describe, expect, it } from 'vitest';
import { id, type RunId } from '@agentboard/shared';
import { harness, unwrap, BOARD, AGENT, HUMAN, STATES } from './harness.js';

/**
 * One agent session, end to end. This is the shape the MCP tools will call in M4 — the same
 * application facade, no adapter-specific logic.
 */
describe('an agent working a task from claim to hand-off', () => {
  it('produces an audit trail that reads like a story', async () => {
    const h = await harness();
    const agentCtx = { ...h.ctx(h.agentToken), runId: id<RunId>('run-42') };

    const task = unwrap(
      await h.app.createTask.execute({
        ...agentCtx,
        boardId: BOARD,
        title: 'Add retry with exponential backoff to the queue consumer',
        acceptanceCriteria: ['unit tests cover the backoff schedule'],
      }),
    );

    const claimed = unwrap(await h.app.claimTask.execute({ ...agentCtx, taskId: task.id, autoStart: true, reason: 'picked up from the queue' }));
    expect(claimed.statusId).toBe(STATES.inProgress);
    expect(claimed.lease?.agentId).toBe(AGENT);

    const commented = unwrap(await h.app.addComment.execute({ ...agentCtx, taskId: task.id, kind: 'result', body: 'backoff implemented, tests green' }));
    expect(commented.comments[0]?.runId).toBe('run-42');

    // The agent cannot cross the human gate.
    const blocked = await h.app.moveTask.execute({ ...agentCtx, taskId: task.id, toStateId: STATES.review, reason: 'ready' });
    expect(blocked.ok).toBe(false);

    // A human can, and then approves.
    unwrap(await h.app.moveTask.execute({ ...h.ctx(h.humanToken), taskId: task.id, toStateId: STATES.review, reason: 'reviewing' }));
    const done = unwrap(await h.app.moveTask.execute({ ...h.ctx(h.humanToken), taskId: task.id, toStateId: STATES.done, reason: 'approved' }));
    expect(done.statusId).toBe(STATES.done);

    const trail = h.activity.all().map((a) => `${a.type}:${a.actorId}`);
    expect(trail).toEqual([
      'TaskCreated:agent-atlas',
      'LeaseAcquired:agent-atlas',
      'TaskAssigned:agent-atlas',
      'TaskMoved:agent-atlas',
      'CommentAdded:agent-atlas',
      'TaskMoved:human-ada',
      'TaskMoved:human-ada',
    ]);

    const outbox = await h.publisher.drain();
    expect(outbox.length).toBe(trail.length);
    expect(outbox.every((row) => row.event.boardId === BOARD)).toBe(true);
  });
});
