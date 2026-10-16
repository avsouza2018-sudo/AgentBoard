import type { ActorId } from '@agentboard/shared';
import type { Actor } from '../model/actor.js';
import type { Tx } from './unitOfWork.js';

/**
 * Resolves a bearer token to an Actor, and looks up an Actor by id.
 * Two different questions — "who is calling?" and "who are we handing this to?" — so they
 * are two different methods.
 */
export interface ActorResolver {
  resolve(token: string): Promise<Actor | null>;
}

export interface ActorDirectory {
  find(tx: Tx, actorId: ActorId): Promise<Actor | null>;
}
