import type { ActorId, RunId } from '@agentboard/shared';
import type { Actor } from '../model/actor.js';
import type { Tx } from './unitOfWork.js';

/**
 * Who performed a registration.
 *
 * This is `Provenance` with one door open: the seed row. The audit trail needs an actor for every
 * event, so `Provenance` requires one; the registry is the only place where a row can exist without
 * someone having performed it — the bootstrap credential, minted by nobody. Naming that exception here
 * is what keeps `Registration.registeredBy` nullable without making every audit event nullable.
 */
export interface RegistrationProvenance {
  readonly actorId: ActorId | null;
  readonly runId: RunId | null;
}

/**
 * A principal as the registry holds it: the actor, plus who put it there.
 *
 * `registeredBy` is not decoration. When a card is moved by a credential nobody granted, the audit
 * trail can only answer "which token did it" — the registry is what answers "who minted that token".
 * It is null only for the bootstrap seed, which is the one registration no one performed.
 */
export interface Registration {
  actor: Actor;
  registeredBy: ActorId | null;
  runId: RunId | null;
  at: Date;
}

/**
 * The directory of principals.
 *
 * `register` returns the credential, and the domain treats that value as an opaque handle: it never
 * parses it, never assumes a prefix, never assumes a length. How a token is minted is the adapter's
 * decision, and that is where it belongs — the domain has no business knowing what a secret looks
 * like. What the domain does own is who is allowed to ask for one (see `policy/registry.ts`), which
 * is why the command calls this port rather than the adapter.
 */
export interface ActorRegistry {
  register(tx: Tx, actor: Actor, provenance: RegistrationProvenance): Promise<string>;
  list(tx: Tx): Promise<Registration[]>;
}
