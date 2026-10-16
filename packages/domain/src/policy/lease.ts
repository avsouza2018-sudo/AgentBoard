import type { AppError, Result } from '@agentboard/shared';
import { err, ok, LeaseExpiredError, LeaseRequiredError } from '@agentboard/shared';
import type { Actor } from '../model/actor.js';
import type { CommentKind, Task } from '../model/task.js';

/** Comment kinds that only the lease holder may write. */
const LEASE_ONLY_KINDS: CommentKind[] = ['result'];

export function canComment(task: Task, actor: Actor, kind: CommentKind, now: Date): Result<true, AppError> {
  const lease = task.lease;
  if (lease !== null && lease.expiresAt <= now) {
    return err(new LeaseExpiredError(task.id, lease.agentId));
  }
  if (LEASE_ONLY_KINDS.includes(kind) && (lease === null || lease.agentId !== actor.id)) {
    return err(new LeaseRequiredError(`comment:${kind}`));
  }
  return ok(true);
}
