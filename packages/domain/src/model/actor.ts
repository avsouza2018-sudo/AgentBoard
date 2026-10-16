import type { ActorId, RunId } from '@agentboard/shared';

export type ActorType = 'human' | 'agent';

/** Board-level role. Agents are members with the `agent` role unless granted more. */
export type Role = 'viewer' | 'member' | 'admin' | 'agent';

export type Scope = 'read' | 'write' | 'transition' | 'comment';

export interface Actor {
  readonly id: ActorId;
  readonly type: ActorType;
  readonly name: string;
  readonly scopes: readonly Scope[];
}

export interface Membership {
  actorId: ActorId;
  role: Role;
}

export function hasScope(actor: Actor, scope: Scope): boolean {
  return actor.scopes.includes(scope);
}

export function roleOf(memberships: readonly Membership[], actorId: ActorId): Role | null {
  const m = memberships.find((x) => x.actorId === actorId);
  return m ? m.role : null;
}

export interface Provenance {
  actorId: ActorId;
  runId: RunId | null;
}
