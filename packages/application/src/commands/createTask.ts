import type { AppError, BoardId, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError, ValidationError } from '@agentboard/shared';
import { Task } from '@agentboard/domain';
import type { Priority, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { Recorder } from '../services/recorder.js';

export interface CreateTaskInput extends CallContext {
  boardId: BoardId;
  title: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  acceptanceCriteria?: string[];
  blockedBy?: TaskId[];
}

export class CreateTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: CreateTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'write');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const board = await this.deps.boards.findById(tx, input.boardId);
      if (!board) return err(new NotFoundError('board', input.boardId));

      const workflow = await this.deps.workflows.findByBoard(tx, input.boardId);
      if (!workflow) return err(new NotFoundError('workflow', input.boardId));

      const start = workflow.orderedStates().find((s) => s.category === 'todo');
      if (!start) return err(new ValidationError('board workflow has no start state', { boardId: input.boardId }));

      const title = input.title.trim();
      if (!title) return err(new ValidationError('title is required'));

      const blockedBy = input.blockedBy ?? [];
      if (blockedBy.length > 0) {
        const blockers = await this.deps.tasks.findMany(tx, blockedBy);
        const missing = blockedBy.filter((id) => !blockers.some((b) => b.id === id));
        if (missing.length > 0) return err(new NotFoundError('task', missing[0]!));
      }

      const now = this.deps.clock.now();
      const seq = await this.deps.keys.next(tx, board.slug);

      const task = new Task({
        id: this.deps.ids.next() as TaskId,
        boardId: board.id,
        key: `${board.slug}-${seq}`,
        title,
        description: input.description ?? '',
        statusId: start.id,
        priority: input.priority ?? 'medium',
        assigneeId: null,
        reporterId: actor.value.id,
        labels: input.labels ?? [],
        blockedBy,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        comments: [],
        lease: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      task.record({
        type: 'TaskCreated',
        aggregateId: task.id,
        boardId: board.id,
        actorId: actor.value.id,
        at: now,
        payload: { key: task.key, state: start.name },
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
