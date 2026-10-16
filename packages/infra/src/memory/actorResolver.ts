import type { Actor, ActorDirectory, ActorResolver } from '@agentboard/domain';
import type { ActorId } from '@agentboard/shared';

export class InMemoryActorStore implements ActorResolver, ActorDirectory {
  private byToken = new Map<string, Actor>();
  private byId = new Map<ActorId, Actor>();

  async register(actor: Actor): Promise<string> {
    const token = `tok-${actor.id}`;
    this.byToken.set(token, actor);
    this.byId.set(actor.id, actor);
    return token;
  }

  async resolve(token: string): Promise<Actor | null> {
    return this.byToken.get(token) ?? null;
  }

  async find(_tx: import('@agentboard/domain').Tx, actorId: ActorId): Promise<Actor | null> {
    return this.byId.get(actorId) ?? null;
  }
}
