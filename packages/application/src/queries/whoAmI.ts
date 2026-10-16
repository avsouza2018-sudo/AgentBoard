import type { AppError, Result } from '@agentboard/shared';
import { ok } from '@agentboard/shared';
import type { Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { roleOf } from '@agentboard/domain';

export class WhoAmI {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(input: CallContext): Promise<Result<Record<string, unknown>, AppError>> {
    const actor = await this.authorizer.actor(input);
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const boards = await this.deps.boards.list(tx);
      return ok({
        actor: { id: actor.value.id, type: actor.value.type, name: actor.value.name, scopes: actor.value.scopes },
        boards: boards.map((b) => ({
          id: b.id,
          name: b.name,
          slug: b.slug,
          role: roleOf(b.members, actor.value.id),
        })),
      });
    });
  }
}
