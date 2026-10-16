/**
 * Shared wiring for the composition roots. The rule still holds: `apps` is the only place that
 * sees every layer at once, and this is the only place that chooses storage. What the two roots
 * differ on is the transport — one connects to an agent over a pipe, one serves a browser and an
 * HTTP client from the same registry.
 */
import type { Deps } from '@agentboard/application';
import type { OutboxReader } from '@agentboard/domain';
import type { ActorLookup, LogSink, RateLimiter } from '@agentboard/adapters';
import { id, type ActorId } from '@agentboard/shared';
import { createTokenBucket, jsonLineSink } from '@agentboard/adapters';
import {
  createPool,
  InMemoryActivityRepository,
  InMemoryActorStore,
  InMemoryBoardRepository,
  InMemoryEventPublisher,
  InMemoryTaskKeySequence,
  InMemoryTaskRepository,
  InMemoryWorkflowRepository,
  makeBoard,
  makeWorkflow,
  MemoryUnitOfWork,
  migrate,
  PgActivityRepository,
  PgActorStore,
  PgBoardRepository,
  PgEventPublisher,
  PgTaskKeySequence,
  PgTaskRepository,
  PgUnitOfWork,
  PgWorkflowRepository,
  SequentialIds,
} from '@agentboard/infra';

/**
 * The application is handed a publisher; the live stream needs a reader. They are the same object,
 * and the composition root is the only place allowed to know it — the application's port says
 * nothing about draining, because the application never drains.
 */
export interface Wiring {
  readonly deps: Deps;
  readonly outbox: OutboxReader;
  /** Where a call is recorded. A deployment fact, so it is chosen here and nowhere below. */
  readonly log: LogSink;
  /** Traffic policy per credential. The domain has no concept of frequency, so it cannot own this. */
  readonly limiter: RateLimiter;
}

const CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY ?? 100);
const REFILL_PER_SECOND = Number(process.env.RATE_LIMIT_REFILL_PER_SECOND ?? 10);

/**
 * The boundary that turns a credential into an actor id, once, so the log can name the actor without
 * printing the credential. The use case still resolves through `Authorizer` for its own authorisation;
 * this is not a second auth path, it is the same port answering a different question.
 */
export function actorLookup(deps: Deps): ActorLookup {
  return async (token: string) => (await deps.resolver.resolve(token))?.id ?? null;
}

export async function memoryWiring(): Promise<Wiring> {
  const boards = new InMemoryBoardRepository();
  const workflows = new InMemoryWorkflowRepository();
  const resolver = new InMemoryActorStore();

  boards.add(makeBoard('board-1', 'AG', 'Agent Work', [
    { actorId: id<ActorId>('agent-atlas'), role: 'agent' },
    { actorId: id<ActorId>('human-ada'), role: 'admin' },
  ]));
  workflows.add(
    makeWorkflow('board-1', 'Default', [
      { id: id('s-todo'), name: 'To Do', category: 'todo', isHumanGate: false, wipLimit: null, order: 1 },
      { id: id('s-inprogress'), name: 'In Progress', category: 'in_progress', isHumanGate: false, wipLimit: 2, order: 2 },
      { id: id('s-review'), name: 'Human Review', category: 'in_progress', isHumanGate: true, wipLimit: null, order: 3 },
      { id: id('s-done'), name: 'Done', category: 'done', isHumanGate: false, wipLimit: null, order: 4 },
    ], [
      { id: 't1', from: id('s-todo'), to: id('s-inprogress'), name: 'start', allowedRoles: ['agent'], requiredFields: [] },
      { id: 't2', from: id('s-inprogress'), to: id('s-review'), name: 'hand off', allowedRoles: ['agent'], requiredFields: ['acceptanceCriteria'] },
      { id: 't3', from: id('s-review'), to: id('s-done'), name: 'approve', allowedRoles: ['admin'], requiredFields: [] },
    ]),
  );

  const uow = new MemoryUnitOfWork();

  // Demo tokens are derived from the actor id, so `Bearer tok-agent-atlas` works. Ada is the seed row —
  // the one credential nobody minted — and atlas's is attributed to her, so the panel can say who put
  // the agent on the board.
  const ada = { id: id<ActorId>('human-ada'), type: 'human', name: 'ada', scopes: ['read', 'write', 'transition', 'comment'] } as const;
  const atlas = { id: id<ActorId>('agent-atlas'), type: 'agent', name: 'atlas', scopes: ['read', 'write', 'transition', 'comment'] } as const;

  await uow.run((tx) => resolver.register(tx, ada, { actorId: null, runId: null }));
  await uow.run((tx) => resolver.register(tx, atlas, { actorId: ada.id, runId: null }));

  const publisher = new InMemoryEventPublisher();

  return {
    deps: {
      uow,
      tasks: new InMemoryTaskRepository(),
      boards,
      workflows,
      activity: new InMemoryActivityRepository(),
      keys: new InMemoryTaskKeySequence(),
      publisher,
      resolver,
      directory: resolver,
      agents: resolver,
      // A live clock, not the test double. A frozen clock made the demo's rate limit never refill and
      // every log line carry the same timestamp: time is not decoration once a policy reads it.
      clock: { now: () => new Date() },
      ids: new SequentialIds(),
    },
    outbox: publisher,
    log: jsonLineSink(process.stderr),
    limiter: createTokenBucket({ capacity: CAPACITY, refillPerSecond: REFILL_PER_SECOND }),
  };
}

export function postgresWiring(pool: ReturnType<typeof createPool>): Wiring {
  const uow = new PgUnitOfWork(pool);
  const store = new PgActorStore(pool);
  const publisher = new PgEventPublisher(pool);

  return {
    deps: {
      uow,
      tasks: new PgTaskRepository(),
      boards: new PgBoardRepository(),
      workflows: new PgWorkflowRepository(),
      activity: new PgActivityRepository(),
      keys: new PgTaskKeySequence(),
      publisher,
      resolver: store,
      directory: store,
      agents: store,
      clock: { now: () => new Date() },
      ids: { next: () => crypto.randomUUID() },
    },
    outbox: publisher,
    log: jsonLineSink(process.stderr),
    limiter: createTokenBucket({ capacity: CAPACITY, refillPerSecond: REFILL_PER_SECOND }),
  };
}

export async function chooseWiring(): Promise<Wiring> {
  const connectionString = process.env.DATABASE_URL ?? '';

  if (connectionString) {
    const pool = createPool(connectionString);
    await migrate(pool);
    return postgresWiring(pool);
  }

  process.stderr.write('agentboard: DATABASE_URL unset, using the in-memory demo board\n');
  return memoryWiring();
}
