import type { AppError, Result } from '@agentboard/shared';
import { err, ok, LeaseExpiredError, LeaseRequiredError } from '@agentboard/shared';
import type { Actor } from '../model/actor.js';
import type { CommentKind, Lease, Task } from '../model/task.js';

/** Comment kinds that only the lease holder may write. */
const LEASE_ONLY_KINDS: CommentKind[] = ['result'];

export type LeaseStatus = 'none' | 'held' | 'expiring' | 'expired';

/**
 * How close to expiry a lease has to be before it is called expiring.
 *
 * The number lives in the domain, not in the page, because the board and the page have to say the
 * same thing about the same lease. A threshold in the UI would be a second definition of staleness,
 * and a second definition is the one that drifts. The domain already refuses a `result` comment on an
 * expired lease, so "about to expire" is the same fact one step earlier — not a new rule, and not a
 * display preference.
 */
export const EXPIRING_WINDOW_MS = 2 * 60 * 1000;

export function leaseStatus(lease: Lease | null, now: Date): LeaseStatus {
  if (lease === null) return 'none';
  if (lease.expiresAt <= now) return 'expired';
  if (lease.expiresAt.getTime() - now.getTime() <= EXPIRING_WINDOW_MS) return 'expiring';
  return 'held';
}

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
