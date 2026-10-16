import type {
  Actor,
  ActorDirectory,
  ActorRegistry,
  ActorResolver,
  Clock,
  Registration,
  RegistrationProvenance,
  Tx,
} from '@agentboard/domain';
import type { ActorId, RunId } from '@agentboard/shared';

interface Stored {
  actor: Actor;
  registeredBy: ActorId | null;
  runId: RunId | null;
  at: Date;
}

/**
 * The directory, the resolver, and the registry — three ports, one store, because they answer three
 * questions about the same rows: who is calling, who are we handing this to, and who is on the roster.
 *
 * The token this adapter mints is readable (`tok-<actor id>`) so the demo board is reproducible.
 * That is a property of this adapter only. The domain receives the value as an opaque handle and must
 * never assume a prefix, a length, or that two registrations produce comparable strings — Postgres
 * mints a uuid, and a rule written against this format would be a rule that works in a test and fails
 * in production.
 */
export class InMemoryActorStore implements ActorResolver, ActorDirectory, ActorRegistry {
  private byToken = new Map<string, Stored>();
  private byId = new Map<ActorId, Stored>();

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  async register(tx: Tx, actor: Actor, provenance: RegistrationProvenance): Promise<string> {
    const token = `tok-${actor.id}`;
    const stored: Stored = {
      actor,
      registeredBy: provenance.actorId,
      runId: provenance.runId,
      at: this.clock.now(),
    };

    this.byToken.set(token, stored);
    this.byId.set(actor.id, stored);
    return token;
  }

  async resolve(token: string): Promise<Actor | null> {
    return this.byToken.get(token)?.actor ?? null;
  }

  async find(_tx: Tx, actorId: ActorId): Promise<Actor | null> {
    return this.byId.get(actorId)?.actor ?? null;
  }

  async list(_tx: Tx): Promise<Registration[]> {
    return [...this.byId.values()].map((stored) => ({ ...stored }));
  }
}
