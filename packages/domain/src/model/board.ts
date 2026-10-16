import type { ActorId, BoardId } from '@agentboard/shared';
import type { Membership, Role } from './actor.js';

export class Board {
  readonly id: BoardId;
  readonly name: string;
  readonly slug: string;
  readonly workflowId: string;

  /**
   * The roster is the aggregate's own state, so granting membership is a method on the aggregate
   * rather than an insert someone performs from outside. A rule that lives in a repository is a rule
   * the read path can bypass; this one cannot.
   */
  private readonly roster: Membership[];

  get members(): readonly Membership[] {
    return this.roster;
  }

  constructor(init: {
    id: BoardId;
    name: string;
    slug: string;
    workflowId: string;
    members: readonly Membership[];
  }) {
    this.id = init.id;
    this.name = init.name;
    this.slug = init.slug;
    this.workflowId = init.workflowId;
    this.roster = [...init.members];
  }

  /** Grant, or re-grant. A role change is the same act as a grant, so it is the same method. */
  grant(actorId: ActorId, role: Role): Membership {
    const existing = this.roster.find((m) => m.actorId === actorId);
    if (existing) {
      existing.role = role;
      return existing;
    }

    const membership: Membership = { actorId, role };
    this.roster.push(membership);
    return membership;
  }
}
