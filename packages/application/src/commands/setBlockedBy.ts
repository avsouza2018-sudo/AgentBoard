import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { assertNoCycle } from '../services/graph.js';
import { Recorder } from '../services/recorder.js';

export interface SetBlockedByInput extends CallContext {
  taskId: TaskId;
  blockers: TaskId[];
}

export class SetBlockedBy {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: SetBlockedByInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'write');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const cycle = await assertNoCycle(tx, this.deps.tasks, task, input.blockers);
      if (!cycle.ok) return cycle;

      task.blockedBy = [...input.blockers];
      task.record({
        type: 'BlockersChanged',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: this.deps.clock.now(),
        payload: { blockers: input.blockers },
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
