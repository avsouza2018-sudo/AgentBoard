import type { ActorId, BoardId, StateId, TaskId } from '@agentboard/shared';
import { ConcurrencyError } from '@agentboard/shared';
import type { Comment, Lease, Page, Task, TaskFilter, TaskRepository, Tx } from '@agentboard/domain';
import { Task as TaskModel } from '@agentboard/domain';

type Snapshot = {
  id: TaskId;
  boardId: BoardId;
  key: string;
  title: string;
  description: string;
  statusId: StateId;
  priority: Task['priority'];
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
};

/**
 * Faithful fake: stores snapshots, not live object references, so `save()` really does
 * compare-and-set against the version the aggregate was loaded at.
 */
export class InMemoryTaskRepository implements TaskRepository {
  private store = new Map<TaskId, Snapshot>();

  async seed(task: Task): Promise<void> {
    this.store.set(task.id, snapshot(task));
  }

  async findById(_tx: Tx, id: TaskId): Promise<Task | null> {
    const s = this.store.get(id);
    return s ? hydrate(s) : null;
  }

  async findMany(_tx: Tx, ids: readonly TaskId[]): Promise<Task[]> {
    const out: Task[] = [];
    for (const id of ids) {
      const s = this.store.get(id);
      if (s) out.push(hydrate(s));
    }
    return out;
  }

  async query(_tx: Tx, filter: TaskFilter): Promise<Page<Task>> {
    let rows = [...this.store.values()].filter((s) => s.boardId === filter.boardId);
    if (filter.statusId) rows = rows.filter((s) => s.statusId === filter.statusId);
    if (filter.assigneeId) rows = rows.filter((s) => s.assigneeId === filter.assigneeId);
    const label = filter.label;
    if (label) rows = rows.filter((s) => s.labels.includes(label));
    if (filter.onlyBlocked) rows = rows.filter((s) => s.blockedBy.length > 0);
    if (filter.query) {
      const q = filter.query.toLowerCase();
      rows = rows.filter((s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
    }

    const offset = filter.cursor ? Number(filter.cursor) : 0;
    const limit = filter.limit ?? 50;
    const items = rows.slice(offset, offset + limit).map(hydrate);
    const next = offset + limit < rows.length ? String(offset + limit) : null;
    return { items, cursor: next };
  }

  async occupantsInState(_tx: Tx, boardId: BoardId, stateId: StateId, excludeTaskId?: TaskId): Promise<string[]> {
    return [...this.store.values()]
      .filter((s) => s.boardId === boardId && s.statusId === stateId && s.id !== excludeTaskId)
      .map((s) => s.key);
  }

  async save(_tx: Tx, task: Task): Promise<void> {
    const existing = this.store.get(task.id);
    if (!existing) {
      this.store.set(task.id, snapshot(task));
      return;
    }
    if (existing.version !== task.version) {
      throw new ConcurrencyError(task.id, task.version, existing.version);
    }
    const next = snapshot(task);
    next.version = task.version + 1;
    this.store.set(task.id, next);
    task.version = next.version;
  }

  snapshotOf(id: TaskId): Snapshot | undefined {
    return this.store.get(id);
  }
}

function snapshot(task: Task): Snapshot {
  return {
    id: task.id,
    boardId: task.boardId,
    key: task.key,
    title: task.title,
    description: task.description,
    statusId: task.statusId,
    priority: task.priority,
    assigneeId: task.assigneeId,
    reporterId: task.reporterId,
    labels: [...task.labels],
    blockedBy: [...task.blockedBy],
    acceptanceCriteria: [...task.acceptanceCriteria],
    comments: task.comments.map((c) => ({ ...c })),
    lease: task.lease ? { ...task.lease } : null,
    version: task.version,
    createdAt: new Date(task.createdAt),
    updatedAt: new Date(task.updatedAt),
  };
}

function hydrate(s: Snapshot): Task {
  return new TaskModel({ ...s });
}
