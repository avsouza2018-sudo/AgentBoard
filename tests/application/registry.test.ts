import { describe, expect, it } from 'vitest';
import { id, type ActorId, type BoardId } from '@agentboard/shared';
import { AGENT, BOARD, HUMAN, harness, unwrap } from '../harness.js';

describe('the registry', () => {
  it('records who minted a credential, not only which credential exists', async () => {
    const h = await harness();

    const registration = unwrap(
      await h.app.registerAgent.execute({
        ...h.ctx(h.humanToken),
        boardId: BOARD,
        actorId: AGENT,
        name: 'atlas',
        type: 'agent',
        role: 'agent',
        scopes: ['read', 'write', 'transition', 'comment'],
      }),
    );

    expect(registration.actor.id).toBe(AGENT);
    expect(registration.registeredBy).toBe(HUMAN);
    expect(unwrap(await h.app.listAgents.execute({ ...h.ctx(h.humanToken), boardId: BOARD }))
      .find((a) => a.id === AGENT)?.registeredBy).toBe(HUMAN);
  });

  it('refuses a credential minted by the fleet itself', async () => {
    const h = await harness();

    // An agent has write scope, so a scope check alone would let it mint a second identity with a
    // broader role. The domain policy is what stops it, and the refusal names the caller.
    const refusal = await h.app.registerAgent.execute({
      ...h.ctx(h.agentToken),
      boardId: BOARD,
      actorId: AGENT,
      name: 'vega',
      type: 'agent',
      role: 'admin',
      scopes: ['read', 'write', 'transition', 'comment'],
    });

    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.error.code).toBe('permission');
    expect(refusal.error.details.required).toBe('admin');

    // Nothing was written: the policy is checked before the registry is asked for a credential.
    expect(unwrap(await h.app.listAgents.execute({ ...h.ctx(h.humanToken), boardId: BOARD })).some((a) => a.name === 'vega')).toBe(false);
  });

  it('grants membership on the board as part of the same write', async () => {
    const h = await harness();
    const NEW_AGENT = id<ActorId>('agent-vega');

    unwrap(
      await h.app.registerAgent.execute({
        ...h.ctx(h.humanToken),
        boardId: BOARD,
        actorId: NEW_AGENT,
        name: 'vega',
        type: 'agent',
        role: 'agent',
        scopes: ['read', 'write', 'comment'],
      }),
    );

    const roster = unwrap(await h.app.listAgents.execute({ ...h.ctx(h.humanToken), boardId: BOARD }));
    const vega = roster.find((a) => a.id === NEW_AGENT);

    expect(vega?.role).toBe('agent');
    expect(vega?.registeredBy).toBe(HUMAN);
    // Agents first, then humans, and inside each group by name: the panel is read top-down, and a
    // roster that arrives in a different order on every read is not a roster.
    expect(roster.map((a) => `${a.type}:${a.name}`)).toEqual(['agent:atlas', 'agent:vega', 'human:ada']);
  });

  it('reports what each principal is holding at the moment of the read', async () => {
    const h = await harness();

    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'Held card' }));
    unwrap(await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id }));

    const roster = unwrap(await h.app.listAgents.execute({ ...h.ctx(h.agentToken), boardId: BOARD }));
    const atlas = roster.find((a) => a.id === AGENT);

    expect(atlas?.held.map((t) => t.key)).toEqual([task.key]);
    expect(atlas?.held[0]?.lease?.status).toBe('held');
    expect(unwrap(await h.app.listAgents.execute({ ...h.ctx(h.agentToken), boardId: BOARD }))
      .find((a) => a.id === HUMAN)?.held).toHaveLength(0);
  });

  it('does not report a lease the server no longer considers live', async () => {
    const h = await harness();

    const task = unwrap(await h.app.createTask.execute({ ...h.ctx(h.agentToken), boardId: BOARD, title: 'Lease about to go' }));
    unwrap(await h.app.claimTask.execute({ ...h.ctx(h.agentToken), taskId: task.id }));

    // The same clock the guard uses. Moving it past expiry changes the read, because the read is the
    // server's judgement — not because the page recomputed anything.
    h.clock.advance(31 * 60 * 1000);

    const roster = unwrap(await h.app.listAgents.execute({ ...h.ctx(h.agentToken), boardId: BOARD }));
    expect(roster.find((a) => a.id === AGENT)?.held).toHaveLength(0);
  });

  it('refuses a read of a board the caller cannot see', async () => {
    const h = await harness();
    const refusal = await h.app.listAgents.execute({ ...h.ctx(h.agentToken), boardId: id<BoardId>('board-2') });

    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(refusal.error.code).toBe('not_found');
  });
});
