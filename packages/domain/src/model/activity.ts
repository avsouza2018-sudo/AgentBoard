import type { BoardId, TaskId, ActorId, RunId } from '@agentboard/shared';
import type { DomainEvent } from '../events.js';

/**
 * Append-only. Nothing in the system updates an ActivityEvent.
 */
export interface ActivityEvent {
  id: string;
  boardId: BoardId;
  taskId: TaskId;
  actorId: ActorId;
  runId: RunId | null;
  type: DomainEvent['type'];
  at: Date;
  payload: Record<string, unknown>;
}

export function activityFrom(event: DomainEvent, id: string, runId: RunId | null): ActivityEvent {
  return {
    id,
    boardId: event.boardId,
    taskId: event.aggregateId,
    actorId: event.actorId,
    runId,
    type: event.type,
    at: event.at,
    payload: event.payload,
  };
}
