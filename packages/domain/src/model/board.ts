import type { BoardId } from '@agentboard/shared';
import type { Membership } from './actor.js';

export class Board {
  readonly id: BoardId;
  readonly name: string;
  readonly slug: string;
  readonly workflowId: string;
  readonly members: readonly Membership[];

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
    this.members = init.members;
  }
}
