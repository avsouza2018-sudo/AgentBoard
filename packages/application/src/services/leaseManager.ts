import type { Actor, Task, Tx } from '@agentboard/domain';
import type { Clock, IdGenerator } from '@agentboard/domain';

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

export class LeaseManager {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ) {}

  acquire(tx: Tx, task: Task, agent: Actor): void {
    const now = this.clock.now();
    task.lease = {
      taskId: task.id,
      agentId: agent.id,
      acquiredAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
      renewCount: 0,
    };
    task.record({
      type: 'LeaseAcquired',
      aggregateId: task.id,
      boardId: task.boardId,
      actorId: agent.id,
      at: now,
      payload: { expiresAt: task.lease.expiresAt.toISOString() },
    });
  }

  renew(tx: Tx, task: Task, agent: Actor): void {
    const now = this.clock.now();
    if (task.lease) {
      task.lease.expiresAt = new Date(now.getTime() + this.ttlMs);
      task.lease.renewCount += 1;
    }
    task.record({
      type: 'LeaseRenewed',
      aggregateId: task.id,
      boardId: task.boardId,
      actorId: agent.id,
      at: now,
      payload: { expiresAt: task.lease?.expiresAt.toISOString() ?? null },
    });
  }

  release(tx: Tx, task: Task, agent: Actor): void {
    const now = this.clock.now();
    task.lease = null;
    task.record({
      type: 'LeaseReleased',
      aggregateId: task.id,
      boardId: task.boardId,
      actorId: agent.id,
      at: now,
      payload: {},
    });
  }
}
