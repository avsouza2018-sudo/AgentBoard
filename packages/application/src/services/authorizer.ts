import type { AppError, Result } from '@agentboard/shared';
import { err, ok, PermissionError } from '@agentboard/shared';
import type { Actor, ActorResolver, Scope } from '@agentboard/domain';
import type { CallContext } from '../context.js';

export class Authorizer {
  constructor(private readonly resolver: ActorResolver) {}

  async actor(ctx: CallContext): Promise<Result<Actor, AppError>> {
    const actor = await this.resolver.resolve(ctx.actorToken);
    if (!actor) return err(new PermissionError(`unknown token: ${ctx.actorToken}`, { token: ctx.actorToken }));
    return ok(actor);
  }

  async requireScope(ctx: CallContext, scope: Scope): Promise<Result<Actor, AppError>> {
    const actor = await this.actor(ctx);
    if (!actor.ok) return actor;
    if (!actor.value.scopes.includes(scope)) {
      return err(new PermissionError(`token lacks scope '${scope}'`, { scope, actorId: actor.value.id }));
    }
    return ok(actor.value);
  }
}
