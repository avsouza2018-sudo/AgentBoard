import { describe, expect, it } from 'vitest';
import { AGENT, AGENT_TOKEN, BOARD, HUMAN, STATES } from '../harness.js';
import { FIELDS } from '../../apps/web/src/contract.js';
import { dataOf, session, unwrap } from './session.js';

const cardOf = (s: Awaited<ReturnType<typeof session>>, taskId: string) =>
  s.store.view.columns.flatMap((column) => column.cards).find((card) => card.id === taskId);

const rosterOf = (s: Awaited<ReturnType<typeof session>>, actorId: string) =>
  s.store.view.agents.find((agent) => agent.id === actorId);

describe('the roster on the page', () => {
  it('reads the roster as the mirror claims it is', async () => {
    const s = await session();

    const roster = dataOf(await s.client.agents(BOARD));
    expect(Object.keys(roster[0] ?? {}).sort()).toEqual([...FIELDS.agent].sort());

    const atlas = roster.find((a) => a.id === AGENT);
    // The audit trail can name the token that moved a card; only the registry names who minted it, and
    // the page shows that fact rather than guessing it.
    expect(atlas?.registeredBy).toBe(HUMAN);

    s.close();
  });

  it('shows which cards each principal is holding at the moment of the read', async () => {
    const s = await session();

    const task = unwrap(await s.h.app.createTask.execute({ actorToken: AGENT_TOKEN, runId: null, boardId: BOARD, title: 'Held by atlas' }));
    unwrap(await s.h.app.claimTask.execute({ actorToken: AGENT_TOKEN, runId: null, taskId: task.id }));

    await s.store.load();

    const atlas = rosterOf(s, AGENT);
    expect(atlas?.held.map((t) => t.key)).toEqual([task.key]);
    expect(atlas?.held[0]?.lease?.status).toBe('held');
    expect(rosterOf(s, HUMAN)?.held).toHaveLength(0);

    s.close();
  });

  it('reports the lease word the server chose, not one it worked out itself', async () => {
    const s = await session();

    const task = unwrap(await s.h.app.createTask.execute({ actorToken: AGENT_TOKEN, runId: null, boardId: BOARD, title: 'About to expire' }));
    unwrap(await s.h.app.claimTask.execute({ actorToken: AGENT_TOKEN, runId: null, taskId: task.id }));

    await s.store.load();
    expect(cardOf(s, task.id)?.lease?.status).toBe('held');

    // Inside the domain's window, the same read says `expiring`. The page did not compare a timestamp
    // against a clock — it re-read, and the server answered with a different word.
    s.h.clock.advance(13 * 60 * 1000);
    await s.store.load();

    expect(cardOf(s, task.id)?.lease?.status).toBe('expiring');
    expect(rosterOf(s, AGENT)?.held[0]?.lease?.status).toBe('expiring');

    // Past the window, the same card is `expired` — and the roster no longer lists it as held, because
    // the server no longer considers the lease live.
    s.h.clock.advance(2 * 60 * 1000);
    await s.store.load();

    expect(cardOf(s, task.id)?.lease?.status).toBe('expired');
    expect(rosterOf(s, AGENT)?.held).toHaveLength(0);

    s.close();
  });

  it('does not change a lease word between reads', async () => {
    const s = await session();

    const task = unwrap(await s.h.app.createTask.execute({ actorToken: AGENT_TOKEN, runId: null, boardId: BOARD, title: 'Read once' }));
    unwrap(await s.h.app.claimTask.execute({ actorToken: AGENT_TOKEN, runId: null, taskId: task.id }));

    await s.store.load();
    const before = cardOf(s, task.id)?.lease?.status;

    // Time passes without a read. The page has no clock of its own, so it cannot decide that the lease
    // has gone stale — it still shows the word the last read gave it.
    s.h.clock.advance(20 * 60 * 1000);
    expect(cardOf(s, task.id)?.lease?.status).toBe(before);

    await s.store.load();
    expect(cardOf(s, task.id)?.lease?.status).toBe('expired');

    s.close();
  });

  it('shows no lease word for a shape that did not carry one', async () => {
    const s = await session();

    const created = dataOf(await s.client.createTask(BOARD, { board_id: BOARD, title: 'Claimed by a write' }));
    await s.client.claim(created.id);
    await s.store.load();

    // The read model carries the word.
    expect(cardOf(s, created.id)?.lease?.status).toBe('held');

    // A write the store performs returns the aggregate, which carries a lease but no status. The store
    // keeps the lease it was given and shows no word until the next read — inventing one here would be
    // the second definition of staleness the whole design exists to avoid.
    await s.store.move(created.id, STATES.inProgress, 'started');
    const card = cardOf(s, created.id);
    expect(card?.lease?.agentId).toBe(AGENT);
    expect(card?.lease?.status).toBeNull();

    // And the mirror is checked against live JSON, not against the store's own copy.
    const page = dataOf(await s.client.listTasks(BOARD));
    const read = page.items.find((t) => t.id === created.id);
    expect(Object.keys(read?.lease ?? {}).sort()).toEqual([...FIELDS.lease].sort());
    expect(read?.lease?.status).toBe('held');

    s.close();
  });

  it('refuses the roster for a caller who cannot see the board', async () => {
    const s = await session();

    const refusal = await s.client.agents('board-2');
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.error.code).toBe('not_found');

    s.close();
  });
});
