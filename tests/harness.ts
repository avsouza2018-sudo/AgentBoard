import { buildApplication, type Deps } from '@agentboard/application';
import {
  FixedClock,
  InMemoryActivityRepository,
  InMemoryActorStore,
  InMemoryBoardRepository,
  InMemoryEventPublisher,
  InMemoryTaskKeySequence,
  InMemoryTaskRepository,
  InMemoryWorkflowRepository,
  MemoryUnitOfWork,
  SequentialIds,
  makeBoard,
  makeWorkflow,
} from '@agentboard/infra';
import {
  AGENT,
  AGENT_ACTOR,
  AGENT_TOKEN,
  BOARD,
  BOARD_NAME,
  BOARD_SLUG,
  HUMAN,
  HUMAN_ACTOR,
  HUMAN_TOKEN,
  MEMBERSHIPS,
  STATES,
  STATE_ROWS,
  TRANSITION_ROWS,
} from './fixtures.js';

export { AGENT, BOARD, HUMAN, STATES, AGENT_TOKEN, HUMAN_TOKEN } from './fixtures.js';

export async function harness() {
  const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
  const ids = new SequentialIds();

  const tasks = new InMemoryTaskRepository();
  const boards = new InMemoryBoardRepository();
  const workflows = new InMemoryWorkflowRepository();
  const activity = new InMemoryActivityRepository();
  const publisher = new InMemoryEventPublisher();
  const keys = new InMemoryTaskKeySequence();
  const resolver = new InMemoryActorStore();
  const uow = new MemoryUnitOfWork();

  const deps: Deps = { uow, tasks, boards, workflows, activity, publisher, keys, resolver, directory: resolver, clock, ids };

  boards.add(makeBoard(BOARD, BOARD_SLUG, BOARD_NAME, MEMBERSHIPS));
  workflows.add(makeWorkflow(BOARD, 'Default', STATE_ROWS, TRANSITION_ROWS));

  const agentToken = await resolver.register(AGENT_ACTOR);
  const humanToken = await resolver.register(HUMAN_ACTOR);

  const app = buildApplication(deps);

  const ctx = (token: string) => ({ actorToken: token, runId: null });

  return { app, deps, clock, tasks, activity, publisher, resolver, agentToken, humanToken, ctx };
}

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value;
}
