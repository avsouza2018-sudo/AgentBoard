import type { BoardId, TaskId, ActorId, StateId } from '@agentboard/shared';
import type { Task } from '../model/task.js';
import type { Tx } from './unitOfWork.js';

export interface TaskFilter {
  boardId: BoardId;
  statusId?: StateId;
  assigneeId?: ActorId;
  label?: string;
  onlyBlocked?: boolean;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

export interface TaskRepository {
  findById(tx: Tx, id: TaskId): Promise<Task | null>;
  findMany(tx: Tx, ids: readonly TaskId[]): Promise<Task[]>;
  query(tx: Tx, filter: TaskFilter): Promise<Page<Task>>;
  /** Keys of tasks already occupying a state, excluding `excludeTaskId`. */
  occupantsInState(tx: Tx, boardId: BoardId, stateId: StateId, excludeTaskId?: TaskId): Promise<string[]>;
  /** Compare-and-set against `task.version`; throws ConcurrencyError on conflict. */
  save(tx: Tx, task: Task): Promise<void>;
}
