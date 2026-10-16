import type { BoardId, TaskId, ActorId, RunId, StateId } from '@agentboard/shared';
import type { DomainEvent } from '../events.js';

export type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

export type CommentKind = 'note' | 'result' | 'question' | 'handoff' | 'escalation';

export interface Comment {
  id: string;
  taskId: TaskId;
  authorId: ActorId;
  kind: CommentKind;
  body: string;
  runId: RunId | null;
  createdAt: Date;
}

/**
 * A work claim. Distinct from assignment: an agent can be assigned without holding the
 * lease, and a lease can be held by someone who is not the assignee.
 */
export interface Lease {
  taskId: TaskId;
  agentId: ActorId;
  acquiredAt: Date;
  expiresAt: Date;
  renewCount: number;
}

export class Task {
  readonly id: TaskId;
  readonly boardId: BoardId;
  readonly key: string;

  title: string;
  description: string;
  statusId: StateId;
  priority: Priority;
  assigneeId: ActorId | null;
  reporterId: ActorId;
  labels: string[];
  blockedBy: TaskId[];
  acceptanceCriteria: string[];
  comments: Comment[];
  lease: Lease | null;

  /** Version as loaded from the store. `save()` performs CAS against this value. */
  version: number;
  createdAt: Date;
  updatedAt: Date;

  private pendingEvents: DomainEvent[] = [];

  constructor(init: {
    id: TaskId;
    boardId: BoardId;
    key: string;
    title: string;
    description: string;
    statusId: StateId;
    priority: Priority;
    assigneeId: ActorId | null;
    reporterId: ActorId;
    labels: string[];
    blockedBy: TaskId[];
    acceptanceCriteria: string[];
    comments: Comment[];
    lease: Lease | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = init.id;
    this.boardId = init.boardId;
    this.key = init.key;
    this.title = init.title;
    this.description = init.description;
    this.statusId = init.statusId;
    this.priority = init.priority;
    this.assigneeId = init.assigneeId;
    this.reporterId = init.reporterId;
    this.labels = init.labels;
    this.blockedBy = init.blockedBy;
    this.acceptanceCriteria = init.acceptanceCriteria;
    this.comments = init.comments;
    this.lease = init.lease;
    this.version = init.version;
    this.createdAt = init.createdAt;
    this.updatedAt = init.updatedAt;
  }

  record(event: DomainEvent): void {
    this.pendingEvents.push(event);
  }

  pullEvents(): DomainEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  /** Mutates the aggregate and records the domain event. Call only after policy approval. */
  applyTransition(args: {
    transitionId: string;
    toStateId: StateId;
    actorId: ActorId;
    at: Date;
    reason: string;
    forceReason?: string;
  }): void {
    const from = this.statusId;
    this.statusId = args.toStateId;
    this.updatedAt = args.at;
    this.record({
      type: 'TaskMoved',
      aggregateId: this.id,
      boardId: this.boardId,
      actorId: args.actorId,
      at: args.at,
      payload: {
        transitionId: args.transitionId,
        from,
        to: args.toStateId,
        reason: args.reason,
        ...(args.forceReason !== undefined ? { forceReason: args.forceReason } : {}),
      },
    });
  }

  hasFieldFilled(field: string): boolean {
    switch (field) {
      case 'title':
        return this.title.trim() !== '';
      case 'description':
        return this.description.trim() !== '';
      case 'acceptanceCriteria':
        return this.acceptanceCriteria.length > 0;
      case 'assignee':
        return this.assigneeId !== null;
      case 'labels':
        return this.labels.length > 0;
      default:
        return false;
    }
  }

  hasActiveLease(agentId: ActorId, now: Date): boolean {
    return this.lease !== null && this.lease.agentId === agentId && this.lease.expiresAt > now;
  }

  leaseExpired(now: Date): boolean {
    return this.lease !== null && this.lease.expiresAt <= now;
  }

  /**
   * The aggregate's own wire shape. `private` is a compile-time word only: `JSON.stringify` sends
   * `pendingEvents`, so a client would be depending on internal state — state that is empty by the
   * time anything reads it, because the use case pulls the events before the transaction commits.
   *
   * Naming the shape here is what makes the mirror in `apps/web` true, and it is the reason the
   * client test can compare the fields it expects against the fields a live server sends.
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      boardId: this.boardId,
      key: this.key,
      title: this.title,
      description: this.description,
      statusId: this.statusId,
      priority: this.priority,
      assigneeId: this.assigneeId,
      reporterId: this.reporterId,
      labels: this.labels,
      blockedBy: this.blockedBy,
      acceptanceCriteria: this.acceptanceCriteria,
      comments: this.comments,
      lease: this.lease,
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
