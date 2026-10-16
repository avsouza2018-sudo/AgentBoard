import type { ActorId, AppError, BoardId, Result } from '@agentboard/shared';
import { err, ok, NotFoundError, ValidationError } from '@agentboard/shared';
import { canRegisterPrincipal, roleOf } from '@agentboard/domain';
import type { ActorType, Registration, RegistrationProvenance, Role, Scope, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';

export interface RegisterAgentInput extends CallContext {
  boardId: BoardId;
  actorId: ActorId;
  name: string;
  type: ActorType;
  role: Role;
  scopes: Scope[];
}

/**
 * Registering a principal.
 *
 * This is the one write in the system whose consequence is an identity, so it is the one write whose
 * permission rule is not a scope check. `registerAgent` is gated by the domain policy
 * `canRegisterPrincipal`: an agent cannot mint a credential, and that is the whole point — the fleet
 * must not be able to create its own members.
 *
 * The credential is returned once, here. No other operation reads it back, which is why the response
 * and the log disagree: the log records who registered whom, never the token.
 */
export class RegisterAgent {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(input: RegisterAgentInput): Promise<Result<Registration, AppError>> {
    const caller = await this.authorizer.requireScope(input, 'write');
    if (!caller.ok) return caller;

    if (!input.name.trim()) return err(new ValidationError('name is required'));
    if (input.scopes.length === 0) return err(new ValidationError('a principal needs at least one scope', { actorId: input.actorId }));

    return this.deps.uow.run(async (tx: Tx) => {
      const board = await this.deps.boards.findById(tx, input.boardId);
      if (!board) return err(new NotFoundError('board', input.boardId));

      const allowed = canRegisterPrincipal(caller.value, roleOf(board.members, caller.value.id));
      if (!allowed.ok) return allowed;

      const actor = {
        id: input.actorId,
        type: input.type,
        name: input.name.trim(),
        scopes: [...input.scopes],
      };

      const provenance: RegistrationProvenance = { actorId: caller.value.id, runId: input.runId };
      const token = await this.deps.agents.register(tx, actor, provenance);

      board.grant(actor.id, input.role);
      await this.deps.boards.save(tx, board);

      const registrations = await this.deps.agents.list(tx);
      const stored = registrations.find((r) => r.actor.id === actor.id);

      return ok(
        stored ?? {
          actor,
          registeredBy: caller.value.id,
          runId: input.runId,
          at: this.deps.clock.now(),
        },
      );
    });
  }
}
