import type { BoardId, TaskId, ActorId, StateId, RunId } from '@agentboard/shared';

export type DomainEventType =
  | 'TaskCreated'
  | 'TaskMoved'
  | 'TaskAssigned'
  | 'TaskUpdated'
  | 'CommentAdded'
  | 'BlockersChanged'
  | 'LeaseAcquired'
  | 'LeaseRenewed'
  | 'LeaseReleased'
  | 'LeaseExpired';

export interface DomainEvent {
  type: DomainEventType;
  aggregateId: TaskId;
  boardId: BoardId;
  actorId: ActorId;
  at: Date;
  payload: Record<string, unknown>;
}
