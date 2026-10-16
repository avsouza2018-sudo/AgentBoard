import type { AppError, Result, StateId } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type {
  Actor,
  BoardRepository,
  Task,
  TaskRepository,
  Transition,
  Tx,
  Workflow,
  WorkflowRepository,
} from '@agentboard/domain';
import { evaluateTransition, roleOf } from '@agentboard/domain';
import type { Clock } from '@agentboard/domain';

/**
 * Gathers the data the pure policy needs, then calls the policy. The policy itself never
 * touches a repository, so every guard failure is explainable and testable.
 */
export class GuardEvaluator {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly workflows: WorkflowRepository,
    private readonly boards: BoardRepository,
    private readonly clock: Clock,
  ) {}

  async transition(
    tx: Tx,
    task: Task,
    toStateId: StateId,
    actor: Actor,
    forceReason?: string,
  ): Promise<Result<{ transition: Transition; workflow: Workflow }, AppError>> {
    const workflow = await this.workflows.findByBoard(tx, task.boardId);
    if (!workflow) return err(new NotFoundError('workflow', task.boardId));

    const board = await this.boards.findById(tx, task.boardId);
    if (!board) return err(new NotFoundError('board', task.boardId));

    const occupants = await this.tasks.occupantsInState(tx, task.boardId, toStateId, task.id);
    const openBlockers = await this.openBlockerKeys(tx, task, workflow);

    const decision = evaluateTransition(task, workflow, toStateId, actor, {
      occupantsInTarget: occupants,
      openBlockers,
      role: roleOf(board.members, actor.id),
      leaseHeldByActor: task.hasActiveLease(actor.id, this.clock.now()),
      ...(forceReason !== undefined ? { forceReason } : {}),
    });

    if (!decision.ok) return decision;
    return ok({ transition: decision.value, workflow });
  }

  private async openBlockerKeys(tx: Tx, task: Task, workflow: Workflow): Promise<string[]> {
    if (task.blockedBy.length === 0) return [];
    const blockers = await this.tasks.findMany(tx, task.blockedBy);
    return blockers
      .filter((b) => {
        const state = workflow.state(b.statusId);
        return state && state.category !== 'done';
      })
      .map((b) => b.key);
  }
}
