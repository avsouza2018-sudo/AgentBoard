import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Application, CallContext } from '@agentboard/application';
import { FixedClock } from '@agentboard/infra';
import * as F from '../fixtures.js';
import { harness, unwrap } from '../harness.js';
import { pgHarness, startPostgres, type PgHarness } from './pgHarness.js';

const runtime = await startPostgres();
if (!runtime) {
  console.warn('Parity test skipped: DATABASE_URL is unset and Docker is unavailable.');
}

const parity = runtime ? describe : describe.skip;

parity('the same use case through both adapters', () => {
  let memory!: Awaited<ReturnType<typeof harness>>;
  let postgres!: PgHarness;

  beforeAll(async () => {
    if (!runtime) return;
    memory = await harness();
    postgres = await pgHarness(runtime);
  });

  afterAll(async () => {
    if (runtime) await runtime.stop();
  });

  /**
   * One scenario, run against two storage implementations. If the ports were lying about anything
   * — ordering, versioning, what counts as an occupant, which guard fires — the two runs would
   * disagree. The audit trail is compared including ids and timestamps, which only line up if the
   * ports really are interchangeable.
   */
  async function runScenario(app: Application, ctx: (token: string) => CallContext, clock: FixedClock) {
    const run = async <T>(call: () => Promise<T>): Promise<T> => {
      clock.advance(1000);
      return call();
    };

    const task = unwrap(
      await run(() => app.createTask.execute({ ...ctx(F.AGENT_TOKEN), boardId: F.BOARD, title: 'Parity task', labels: ['parity'] })),
    );

    unwrap(
      await run(() => app.claimTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, autoStart: true, reason: 'picked up' })),
    );

    unwrap(
      await run(() => app.updateTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, acceptanceCriteria: ['tests pass'] })),
    );

    unwrap(
      await run(() => app.addComment.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, kind: 'result', body: 'work done' })),
    );

    // The agent cannot enter a human-gate state, so it escalates instead of moving the card.
    const deniedGate = await run(() =>
      app.moveTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, toStateId: F.STATES.review, reason: 'handoff' }),
    );

    unwrap(
      await run(() => app.escalate.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, humanActorId: F.HUMAN, note: 'needs approval' })),
    );

    unwrap(
      await run(() => app.moveTask.execute({ ...ctx(F.HUMAN_TOKEN), taskId: task.id, toStateId: F.STATES.review, reason: 'in review' })),
    );

    // Now the card is in a state the agent could reach, but this transition is role-restricted.
    const deniedRole = await run(() =>
      app.moveTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, toStateId: F.STATES.done, reason: 'self-approve' }),
    );

    unwrap(
      await run(() => app.moveTask.execute({ ...ctx(F.HUMAN_TOKEN), taskId: task.id, toStateId: F.STATES.done, reason: 'approved' })),
    );

    const detail = unwrap(await app.getTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, activityLimit: 50 }));
    const codes = [deniedGate.ok ? 'ok' : deniedGate.error.code, deniedRole.ok ? 'ok' : deniedRole.error.code];

    return { taskKey: task.key, codes, detail };
  }

  it('produces the same task state through both adapters', async () => {
    if (!runtime) return;

    const a = await runScenario(memory.app, memory.ctx, memory.clock);
    const b = await runScenario(postgres.app, postgres.ctx, postgres.clock);

    expect(b.detail.task).toEqual(a.detail.task);
    expect(b.detail.comments).toEqual(a.detail.comments);
    expect(b.detail.acceptanceCriteria).toEqual(a.detail.acceptanceCriteria);
    expect(b.taskKey).toBe(a.taskKey);
    expect(b.codes).toEqual(a.codes);
    expect(b.codes).toEqual(['human_gate', 'permission']);
    expect(b.detail.task.statusName).toBe('Done');
    expect(b.detail.task.assigneeId).toBe(F.HUMAN);
  });

  it('produces the same audit trail in the same order', async () => {
    if (!runtime) return;

    const memoryTrail = unwrap(await memory.app.getActivity.execute({ ...memory.ctx(F.AGENT_TOKEN), boardId: F.BOARD, limit: 100 }));
    const postgresTrail = unwrap(await postgres.app.getActivity.execute({ ...postgres.ctx(F.AGENT_TOKEN), boardId: F.BOARD, limit: 100 }));

    expect(postgresTrail).toEqual(memoryTrail);
    expect(memoryTrail.length).toBeGreaterThan(8);
  });

  it('names the same occupants when the WIP limit is hit', async () => {
    if (!runtime) return;

    async function fill(app: Application, ctx: (token: string) => CallContext, clock: FixedClock) {
      const keys: string[] = [];
      for (const title of ['WIP one', 'WIP two']) {
        const task = unwrap(await app.createTask.execute({ ...ctx(F.AGENT_TOKEN), boardId: F.BOARD, title }));
        keys.push(task.key);
        clock.advance(1000);
        unwrap(await app.claimTask.execute({ ...ctx(F.AGENT_TOKEN), taskId: task.id, autoStart: true, reason: 'start' }));
      }

      const third = unwrap(await app.createTask.execute({ ...ctx(F.AGENT_TOKEN), boardId: F.BOARD, title: 'WIP three' }));
      clock.advance(1000);
      const denied = await app.moveTask.execute({
        ...ctx(F.AGENT_TOKEN),
        taskId: third.id,
        toStateId: F.STATES.inProgress,
        reason: 'start',
      });

      if (denied.ok) throw new Error('expected the WIP limit to reject the move');
      return { keys, occupants: denied.error.details.occupants, code: denied.error.code };
    }

    const a = await fill(memory.app, memory.ctx, memory.clock);
    const b = await fill(postgres.app, postgres.ctx, postgres.clock);

    expect(b).toEqual(a);
    expect(a.code).toBe('wip_limit');
  });
});
