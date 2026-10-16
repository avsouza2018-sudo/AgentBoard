import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, LeaseRequiredError, NotFoundError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { LeaseManager } from '../services/leaseManager.js';
import { Recorder } from '../services/recorder.js';

export interface ReleaseTaskInput extends CallContext {
  taskId: TaskId;
  unassign?: boolean;
  reason?: string;
}

export class ReleaseTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly leases: LeaseManager,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: ReleaseTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'transition');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const now = this.deps.clock.now();
      if (!task.lease) return err(new LeaseRequiredError('release'));
      // Releasing is allowed for the holder, or for a human clearing a stale lease.
      if (task.lease.agentId !== actor.value.id && actor.value.type !== 'human') {
        return err(new LeaseRequiredError('release'));
      }

      this.leases.release(tx, task, actor.value);
      if (input.unassign) task.assigneeId = null;

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
