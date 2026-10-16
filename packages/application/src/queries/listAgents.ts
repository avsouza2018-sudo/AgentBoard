import type { AppError, BoardId, Result } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { roleOf } from '@agentboard/domain';
import { toTaskSummary, type TaskSummary } from './map.js';

export interface AgentView {
  id: string;
  type: string;
  name: string;
  role: string;
  scopes: string[];
  /** Who minted the credential. Null only for the bootstrap seed. */
  registeredBy: string | null;
  /** Cards this actor holds a live lease on, right now. */
  held: TaskSummary[];
  lastActivityAt: string | null;
}

/**
 * The board's roster as a read model: who is on it, who put them there, and what each of them is
 * holding at the moment of the read.
 *
 * `held` is not a count the caller computes. It is the lease the server still considers live at the
 * moment it answered, using the same clock the guard uses when it refuses a comment on an expired
 * lease. A page that decided "this lease looks stale" would be a second definition of staleness, and
 * the second definition is the one that drifts.
 */
export class ListAgents {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(input: CallContext & { boardId: BoardId }): Promise<Result<AgentView[], AppError>> {
    const actor = await this.authorizer.requireScope(input, 'read');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const board = await this.deps.boards.findById(tx, input.boardId);
      if (!board) return err(new NotFoundError('board', input.boardId));

      const workflow = await this.deps.workflows.findByBoard(tx, input.boardId);
      if (!workflow) return err(new NotFoundError('workflow', input.boardId));

      const registrations = await this.deps.agents.list(tx);
      const byActor = new Map(registrations.map((r) => [r.actor.id, r]));

      const now = this.deps.clock.now();
      const page = await this.deps.tasks.query(tx, { boardId: board.id, limit: 200 });
      const activity = await this.deps.activity.readForBoard(tx, board.id, 200);

      const views = board.members.map((membership) => {
        const registration = byActor.get(membership.actorId);
        const held = page.items.filter(
          (task) => task.lease !== null && task.lease.agentId === membership.actorId && !task.leaseExpired(now),
        );
        const events = activity.filter((event) => event.actorId === membership.actorId);
        const last = events.length > 0 ? (events[events.length - 1] as (typeof events)[number]) : null;

        return {
          id: membership.actorId,
          type: registration?.actor.type ?? 'unknown',
          name: registration?.actor.name ?? membership.actorId,
          role: roleOf(board.members, membership.actorId) ?? membership.role,
          scopes: [...(registration?.actor.scopes ?? [])],
          registeredBy: registration?.registeredBy ?? null,
          held: held.map((task) => toTaskSummary(task, workflow, now)),
          lastActivityAt: last ? last.at.toISOString() : null,
        };
      });

      // Agents first, then humans, then by name: the panel is read top-down, and a roster that comes
      // back in a different order on every read is not a roster.
      return ok(
        views.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'agent' ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      );
    });
  }
}
