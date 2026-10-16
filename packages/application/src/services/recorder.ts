import type { RunId } from '@agentboard/shared';
import type { ActivityRepository, EventPublisher, IdGenerator, Task, Tx } from '@agentboard/domain';
import { activityFrom } from '@agentboard/domain';

/**
 * Every aggregate change lands in the append-only audit log and the outbox inside the same
 * transaction as the aggregate write. That is what keeps the audit trail and the live board
 * in agreement.
 */
export class Recorder {
  constructor(
    private readonly activity: ActivityRepository,
    private readonly publisher: EventPublisher,
    private readonly ids: IdGenerator,
  ) {}

  async flush(tx: Tx, task: Task, runId: RunId | null): Promise<void> {
    for (const event of task.pullEvents()) {
      await this.activity.append(tx, activityFrom(event, this.ids.next(), runId));
      await this.publisher.publish(tx, event, runId);
    }
  }
}
