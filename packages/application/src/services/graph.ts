import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, CycleError, NotFoundError } from '@agentboard/shared';
import type { Task, TaskRepository, Tx, Workflow, WorkflowRepository } from '@agentboard/domain';

/**
 * Refuses a blocker edge that would close a cycle. Walks the existing `blockedBy` graph
 * from the candidate blocker and fails if it can reach `task`.
 */
export async function assertNoCycle(
  tx: Tx,
  tasks: TaskRepository,
  task: Task,
  blockerIds: readonly TaskId[],
): Promise<Result<true, AppError>> {
  const seen = new Set<TaskId>();
  const stack = [...blockerIds];

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === task.id) {
      return err(new CycleError([task.id, ...Array.from(seen)]));
    }
    if (seen.has(currentId)) continue;
    seen.add(currentId);

    const current = await tasks.findById(tx, currentId);
    if (!current) return err(new NotFoundError('task', currentId));
    stack.push(...current.blockedBy);
  }

  return ok(true);
}

export function isDone(workflow: Workflow, task: Task): boolean {
  const state = workflow.state(task.statusId);
  return state?.category === 'done';
}
