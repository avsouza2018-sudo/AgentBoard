import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN, BOARD, STATES, harness } from '../harness.js';
import type { BoardStore } from '../../apps/web/src/store.js';
import { dataOf, gate, session, unwrap } from './session.js';

type Harness = Awaited<ReturnType<typeof harness>>;

const cardOf = (store: BoardStore, taskId: string) =>
  store.view.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);

async function createTask(h: Harness, title: string) {
  return unwrap(
    await h.app.createTask.execute({
      actorToken: AGENT_TOKEN,
      runId: null,
      boardId: BOARD,
      title,
      acceptanceCriteria: ['the test proves it'],
    }),
  );
}

describe('the board page', () => {
  it('moves the card when the page asks, and settles when the answer arrives', async () => {
    const held = gate();
    const s = await session(held.fetchImpl);
    const task = await createTask(s.h, 'Wire the retry');
    await s.store.load();

    // Called without awaiting: the pending state is the point, and it only exists in the moment
    // between the ask and the answer.
    const pending = s.store.move(task.id, STATES.inProgress, 'starting the work');
    const card = cardOf(s.store, task.id);

    expect(card?.statusName).toBe('In Progress');
    expect(card?.pending).toBe(true);

    held.release();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    const settled = cardOf(s.store, task.id);
    expect(settled?.pending).toBe(false);
    expect(settled?.statusName).toBe('In Progress');

    // The settled card is the server's, not the page's: the version came back from the write.
    const server = dataOf(await s.client.task(task.id));
    expect(settled?.version).toBe(server.task.version);

    s.close();
  });

  it('rolls a refused card back to where the server says it is, not to where the page thought it was', async () => {
    const held = gate();
    const s = await session(held.fetchImpl);
    const task = await createTask(s.h, 'Refuse politely');
    await s.store.load();

    // Done is not reachable from To Do, and not from In Progress either, so the same guard answers
    // whichever order the two calls run in. The point of this test is not which guard fires — it is
    // where the card ends up after the refusal.
    const pending = s.store.move(task.id, STATES.done, 'closing it');
    expect(cardOf(s.store, task.id)?.statusName).toBe('Done');

    // While the call is in flight, another actor moves the same card somewhere else.
    unwrap(
      await s.h.app.moveTask.execute({
        actorToken: AGENT_TOKEN,
        runId: null,
        taskId: task.id,
        toStateId: STATES.inProgress,
        reason: 'another agent picked it up',
      }),
    );

    held.release();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');

    const rolledBack = cardOf(s.store, task.id);
    expect(rolledBack?.pending).toBe(false);
    expect(rolledBack?.statusName).toBe('In Progress'); // the server's position, not To Do
    expect(rolledBack?.refusal?.code).toBe('transition_not_allowed');

    s.close();
  });

  it("shows the refusal in the domain's own words", async () => {
    const s = await session();
    const task = await createTask(s.h, 'Needs a human');
    await s.store.load();

    unwrap(
      await s.h.app.moveTask.execute({
        actorToken: AGENT_TOKEN,
        runId: null,
        taskId: task.id,
        toStateId: STATES.inProgress,
        reason: 'started',
      }),
    );

    const outcome = await s.store.move(task.id, STATES.review, 'hand off for approval');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');

    // The same code, the same message, the same `retryable` an agent would get over MCP. The client
    // did not translate it into a browser-shaped error.
    const card = cardOf(s.store, task.id);
    expect(card?.refusal?.code).toBe('human_gate');
    expect(card?.refusal?.message).toBe(outcome.error.message);
    expect(card?.refusal?.retryable).toBe(outcome.error.retryable);
    expect(card?.statusName).toBe('In Progress');

    s.close();
  });

  it('rolls back to the server when the guard is a WIP limit', async () => {
    const s = await session();

    const first = await createTask(s.h, 'Occupies the column');
    const second = await createTask(s.h, 'Occupies it too');
    const third = await createTask(s.h, 'Cannot fit');

    for (const task of [first, second]) {
      unwrap(
        await s.h.app.moveTask.execute({
          actorToken: AGENT_TOKEN,
          runId: null,
          taskId: task.id,
          toStateId: STATES.inProgress,
          reason: 'started',
        }),
      );
    }

    await s.store.load();
    const outcome = await s.store.move(third.id, STATES.inProgress, 'started');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.error.code).toBe('wip_limit');

    const card = cardOf(s.store, third.id);
    expect(card?.statusName).toBe('To Do');
    expect(s.store.view.columns.find((c) => c.stateId === STATES.inProgress)?.cards).toHaveLength(2);

    s.close();
  });

  it('renders the graph as the server described it, and lets the answer be the policy', async () => {
    const s = await session();
    await s.store.load();

    // The page shows the hand-off even though its actor is an agent and the target is a human gate.
    // Filtering that in the UI would be a second copy of the rule, and it would be the copy that
    // drifts.
    const transitions = s.store.transitionsFrom(STATES.inProgress);
    expect(transitions.map((t) => t.name)).toEqual(['hand off']);
    expect(transitions[0]?.to).toBe(STATES.review);

    s.close();
  });

  it('lets a live frame move a card, but not one that is still in flight', async () => {
    const held = gate();
    const s = await session(held.fetchImpl);

    const mine = await createTask(s.h, 'In flight');
    const theirs = await createTask(s.h, 'Moved by another agent');
    await s.store.load();

    const inFlight = s.store.move(mine.id, STATES.inProgress, 'mine');

    // The frames exactly as the adapter writes them: `data` is the domain event plus the run that
    // produced it, and the new state lives in the payload.
    const frameFor = (taskId: string, to: string, rowId: string) => ({
      id: rowId,
      event: 'TaskMoved',
      data: {
        type: 'TaskMoved',
        aggregateId: taskId,
        boardId: BOARD,
        actorId: 'agent-atlas',
        at: '2026-10-15T12:00:00.000Z',
        runId: 'run-other-agent',
        payload: { transitionId: 't1', from: STATES.todo, to, reason: 'picked it up' },
      },
    });

    // A frame is a committed fact, so it is recorded. It cannot overwrite a card whose own call has
    // not come back yet — that card belongs to the call, and the call will resolve with either the
    // aggregate or a refusal.
    s.store.applyFrame(frameFor(theirs.id, STATES.inProgress, 'outbox-1'));
    s.store.applyFrame(frameFor(mine.id, STATES.done, 'outbox-2'));

    expect(cardOf(s.store, theirs.id)?.statusName).toBe('In Progress');
    expect(cardOf(s.store, mine.id)?.statusName).toBe('In Progress'); // the pending target, not the frame's claim
    expect(s.store.view.feed).toHaveLength(2);

    held.release();
    const outcome = await inFlight;

    expect(outcome.ok).toBe(true);
    expect(s.store.view.feed).toHaveLength(2);
    expect(cardOf(s.store, mine.id)?.pending).toBe(false);

    s.close();
  });
});
