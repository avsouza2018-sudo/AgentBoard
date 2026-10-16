import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Priority, Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { Recorder } from '../services/recorder.js';

export interface UpdateTaskInput extends CallContext {
  taskId: TaskId;
  title?: string;
  description?: string;
  priority?: Priority;
  labels?: string[];
  acceptanceCriteria?: string[];
}

export class UpdateTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: UpdateTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'write');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const changed: Record<string, unknown> = {};
      if (input.title !== undefined) {
        task.title = input.title.trim();
        changed.title = task.title;
      }
      if (input.description !== undefined) {
        task.description = input.description;
        changed.description = task.description;
      }
      if (input.priority !== undefined) {
        task.priority = input.priority;
        changed.priority = task.priority;
      }
      if (input.labels !== undefined) {
        task.labels = input.labels;
        changed.labels = task.labels;
      }
      if (input.acceptanceCriteria !== undefined) {
        task.acceptanceCriteria = input.acceptanceCriteria;
        changed.acceptanceCriteria = task.acceptanceCriteria;
      }

      if (Object.keys(changed).length === 0) return ok(task);

      task.updatedAt = this.deps.clock.now();
      task.record({
        type: 'TaskUpdated',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: task.updatedAt,
        payload: changed,
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
