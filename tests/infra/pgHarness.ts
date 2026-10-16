import { GenericContainer, Wait } from 'testcontainers';
import type { Pool } from 'pg';
import { buildApplication, type Application, type CallContext, type Deps } from '@agentboard/application';
import {
  FixedClock,
  SequentialIds,
  createPool,
  migrate,
  PgActivityRepository,
  PgActorStore,
  PgBoardRepository,
  PgEventPublisher,
  PgTaskKeySequence,
  PgTaskRepository,
  PgUnitOfWork,
  PgWorkflowRepository,
} from '@agentboard/infra';
import * as F from '../fixtures.js';

export interface PgRuntime {
  pool: Pool;
  stop: () => Promise<void>;
}

/**
 * DATABASE_URL wins when it is set; otherwise a throwaway container is started. If neither is
 * available the tests skip rather than fail, so the suite stays green on a machine without Docker.
 */
export async function startPostgres(): Promise<PgRuntime | null> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pool = createPool(url);
    try {
      await pool.query('select 1');
      return { pool, stop: () => pool.end() };
    } catch {
      await pool.end();
      return null;
    }
  }

  try {
    const container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'agentboard' })
      .withExposedPorts(5432)
      .withStartupTimeout(60_000)
      // Waiting on the log message alone is not enough: Postgres logs "ready to accept
      // connections" for its temporary init server, then restarts and drops connections.
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    const pool = createPool(
      `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/agentboard`,
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await pool.query('select 1');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return {
      pool,
      stop: async () => {
        await pool.end();
        await container.stop();
      },
    };
  } catch {
    return null;
  }
}

export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    for (const actor of [F.AGENT_ACTOR, F.HUMAN_ACTOR]) {
      await client.query('insert into actors (id, type, name, scopes) values ($1, $2, $3, $4)', [
        actor.id,
        actor.type,
        actor.name,
        [...actor.scopes],
      ]);
    }

    await client.query('insert into boards (id, name, slug, workflow_id) values ($1, $2, $3, $4)', [
      F.BOARD,
      F.BOARD_NAME,
      F.BOARD_SLUG,
      F.WORKFLOW_ID,
    ]);

    for (const member of F.MEMBERSHIPS) {
      await client.query('insert into board_members (board_id, actor_id, role) values ($1, $2, $3)', [
        F.BOARD,
        member.actorId,
        member.role,
      ]);
    }

    await client.query('insert into workflows (id, board_id, name) values ($1, $2, $3)', [
      F.WORKFLOW_ID,
      F.BOARD,
      'Default',
    ]);

    for (const state of F.STATE_ROWS) {
      await client.query(
        `insert into workflow_states (id, workflow_id, name, category, is_human_gate, wip_limit, "order")
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [state.id, F.WORKFLOW_ID, state.name, state.category, state.isHumanGate, state.wipLimit, state.order],
      );
    }

    for (const transition of F.TRANSITION_ROWS) {
      await client.query(
        `insert into workflow_transitions (id, workflow_id, from_state, to_state, name, allowed_roles, required_fields)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [transition.id, F.WORKFLOW_ID, transition.from, transition.to, transition.name, [...transition.allowedRoles], [...transition.requiredFields]],
      );
    }
  } finally {
    client.release();
  }

  const actors = new PgActorStore(pool);
  await actors.register(F.AGENT_ACTOR, F.AGENT_TOKEN);
  await actors.register(F.HUMAN_ACTOR, F.HUMAN_TOKEN);
}

export async function pgHarness(runtime: PgRuntime) {
  await migrate(runtime.pool);
  await seed(runtime.pool);

  const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
  const ids = new SequentialIds();

  const uow = new PgUnitOfWork(runtime.pool);
  const tasks = new PgTaskRepository();
  const boards = new PgBoardRepository();
  const workflows = new PgWorkflowRepository();
  const activity = new PgActivityRepository();
  const publisher = new PgEventPublisher(runtime.pool);
  const keys = new PgTaskKeySequence();
  const actors = new PgActorStore(runtime.pool);

  const deps: Deps = {
    uow,
    tasks,
    boards,
    workflows,
    activity,
    publisher,
    keys,
    resolver: actors,
    directory: actors,
    clock,
    ids,
  };

  const app: Application = buildApplication(deps);
  const ctx = (token: string): CallContext => ({ actorToken: token, runId: null });

  return { app, deps, clock, ids, publisher, ctx, pool: runtime.pool };
}

export type PgHarness = Awaited<ReturnType<typeof pgHarness>>;
