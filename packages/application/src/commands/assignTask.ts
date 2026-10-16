import type { ActorId, AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError, PermissionError } from '@agentboard/shared';
import { roleOf } from '@agentboard/domain';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { Recorder } from '../services/recorder.js';

export interface AssignTaskInput extends CallContext {
  taskId: TaskId;
  assigneeId: ActorId | null;
}

export class AssignTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: AssignTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'write');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      if (input.assigneeId !== null) {
        const board = await this.deps.boards.findById(tx, task.boardId);
        if (!board) return err(new NotFoundError('board', task.boardId));
        if (roleOf(board.members, input.assigneeId) === null) {
          return err(new PermissionError('assignee is not a member of the board', { assigneeId: input.assigneeId }));
        }
      }

      task.assigneeId = input.assigneeId;
      task.updatedAt = this.deps.clock.now();
      task.record({
        type: 'TaskAssigned',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: task.updatedAt,
        payload: { assigneeId: input.assigneeId },
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
