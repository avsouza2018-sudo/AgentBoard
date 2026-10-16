import type { AppError, Result, StateId, TaskId } from '@agentboard/shared';
import { err, ok, LeaseConflictError, NotFoundError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { GuardEvaluator } from '../services/guardEvaluator.js';
import { LeaseManager } from '../services/leaseManager.js';
import { Recorder } from '../services/recorder.js';

export interface ClaimTaskInput extends CallContext {
  taskId: TaskId;
  /** If a guarded transition to an in_progress state exists, take it. */
  autoStart?: boolean;
  reason?: string;
}

export class ClaimTask {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly guards: GuardEvaluator,
    private readonly leases: LeaseManager,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: ClaimTaskInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'transition');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const now = this.deps.clock.now();
      if (task.lease && !task.leaseExpired(now)) {
        return err(new LeaseConflictError(task.id, task.lease.agentId, task.lease.expiresAt));
      }

      // Policy is evaluated before anything is mutated: a rejected claim must not leave a
      // half-applied transition behind, which is what a real transaction rollback guarantees.
      let targetTransition: { id: string; toStateId: StateId } | null = null;
      if (input.autoStart) {
        const workflow = await this.deps.workflows.findByBoard(tx, task.boardId);
        if (!workflow) return err(new NotFoundError('workflow', task.boardId));
        const target = workflow.orderedStates().find((s) => s.category === 'in_progress');
        const transition = target ? workflow.findTransition(task.statusId, target.id) : undefined;
        if (transition) {
          const decision = await this.guards.transition(tx, task, target!.id, actor.value, input.reason);
          if (!decision.ok) return decision;
          targetTransition = { id: decision.value.transition.id, toStateId: target!.id };
        }
      }

      this.leases.acquire(tx, task, actor.value);
      task.assigneeId = actor.value.id;
      task.record({
        type: 'TaskAssigned',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: now,
        payload: { assigneeId: actor.value.id },
      });

      if (targetTransition) {
        task.applyTransition({
          transitionId: targetTransition.id,
          toStateId: targetTransition.toStateId,
          actorId: actor.value.id,
          at: now,
          reason: (input.reason ?? 'claimed by agent').trim(),
        });
      }

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
