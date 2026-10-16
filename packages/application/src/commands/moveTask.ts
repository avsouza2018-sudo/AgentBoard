import type { AppError, Result, StateId, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError, ValidationError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { GuardEvaluator } from '../services/guardEvaluator.js';
import { Recorder } from '../services/recorder.js';

export interface MoveTaskInput extends CallContext {
  taskId: TaskId;
  toStateId: StateId;
  /** Required: the audit log must be able to answer "why did this card move?". */
  reason: string;
  /** Explicit override of the blocker guard; recorded in the audit trail. */
  forceReason?: string;
}

export class MoveTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly guards: GuardEvaluator,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: MoveTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'transition');
    if (!actor.ok) return actor;
    if (!input.reason.trim()) return err(new ValidationError('reason is required for a transition'));

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const decision = await this.guards.transition(tx, task, input.toStateId, actor.value, input.forceReason);
      if (!decision.ok) return decision;

      task.applyTransition({
        transitionId: decision.value.transition.id,
        toStateId: input.toStateId,
        actorId: actor.value.id,
        at: this.deps.clock.now(),
        reason: input.reason.trim(),
        ...(input.forceReason !== undefined ? { forceReason: input.forceReason } : {}),
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
