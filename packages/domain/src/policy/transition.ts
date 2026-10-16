import type { AppError, Result, StateId } from '@agentboard/shared';
import { err, ok } from '@agentboard/shared';
import { BlockedError, HumanGateError, LeaseRequiredError, PermissionError, TransitionNotAllowedError, ValidationError, WipLimitError } from '@agentboard/shared';
import type { Actor, Role } from '../model/actor.js';
import type { Task } from '../model/task.js';
import type { Transition, Workflow } from '../model/workflow.js';

export interface TransitionContext {
  /** Task keys already occupying the target state (this task excluded). */
  occupantsInTarget: string[];
  /** Task keys of open blockers. */
  openBlockers: string[];
  /** Actor's role on the board; null when not a member. */
  role: Role | null;
  /** True when the actor holds a live lease on the task. */
  leaseHeldByActor: boolean;
  /** Present only when the caller explicitly overrode the blocker guard. */
  forceReason?: string;
}

/**
 * Pure. Takes the data it needs as arguments instead of reaching for a repository or a
 * clock, so every guard failure is reproducible in a unit test.
 */
export function evaluateTransition(
  task: Task,
  workflow: Workflow,
  toStateId: StateId,
  actor: Actor,
  ctx: TransitionContext,
): Result<Transition, AppError> {
  const target = workflow.state(toStateId);
  if (!target) {
    return err(new ValidationError(`state ${toStateId} does not exist on this board`, { state: toStateId }));
  }

  const transition = workflow.findTransition(task.statusId, toStateId);
  if (!transition) {
    const from = workflow.state(task.statusId);
    return err(
      new TransitionNotAllowedError(
        `no transition from '${from?.name ?? task.statusId}' to '${target.name}'`,
        { from: task.statusId, to: toStateId, allowed: workflow.transitions.filter((t) => t.from === task.statusId).map((t) => t.to) },
      ),
    );
  }

  // Guard order is deliberate. When two guards fail at once, the caller is told the one they can
  // act on: a missing field is fixable, a disallowed role is not — an agent that cannot run the
  // transition at all should not be sent off to fill in fields. The human gate comes after
  // completeness for the same reason: if the card is not ready, that is the actionable failure,
  // and a human with the right role can still be told what is missing.
  if (!transition.allowedRoles.includes(ctx.role ?? 'viewer')) {
    return err(
      new PermissionError(`role '${ctx.role ?? 'none'}' may not run transition '${transition.name}'`, {
        transition: transition.name,
        role: ctx.role,
        allowedRoles: transition.allowedRoles,
      }),
    );
  }

  for (const field of transition.requiredFields) {
    if (!task.hasFieldFilled(field)) {
      return err(
        new ValidationError(`transition '${transition.name}' requires ${field}`, {
          transition: transition.name,
          missingField: field,
        }),
      );
    }
  }

  if (target.isHumanGate && actor.type === 'agent') {
    return err(new HumanGateError(target.name));
  }

  if (target.category === 'in_progress' && ctx.openBlockers.length > 0 && !ctx.forceReason) {
    return err(new BlockedError(ctx.openBlockers));
  }

  if (target.category === 'done' && actor.type === 'agent' && !ctx.leaseHeldByActor) {
    return err(new LeaseRequiredError('complete'));
  }

  if (target.wipLimit !== null && ctx.occupantsInTarget.length >= target.wipLimit) {
    return err(new WipLimitError(target.name, target.wipLimit, ctx.occupantsInTarget));
  }

  return ok(transition);
}
