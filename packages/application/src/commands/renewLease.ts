import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, LeaseExpiredError, LeaseRequiredError, NotFoundError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { LeaseManager } from '../services/leaseManager.js';
import { Recorder } from '../services/recorder.js';

/** Heartbeat for long-running agents. */
export class RenewLease {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly leases: LeaseManager,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: CallContext & { taskId: TaskId }): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'transition');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const now = this.deps.clock.now();
      if (!task.lease) return err(new LeaseRequiredError('renew'));
      if (task.leaseExpired(now)) {
        return err(new LeaseExpiredError(task.id, task.lease.agentId));
      }
      if (task.lease.agentId !== actor.value.id) {
        return err(new LeaseRequiredError('renew'));
      }

      this.leases.renew(tx, task, actor.value);
      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
