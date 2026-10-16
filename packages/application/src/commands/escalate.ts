import type { ActorId, AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError, PermissionError, ValidationError } from '@agentboard/shared';
import type { Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { Recorder } from '../services/recorder.js';

/** The agent -> human handoff primitive: escalation comment + human assignee. */
export class Escalate {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: CallContext & { taskId: TaskId; humanActorId: ActorId; note: string }): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'comment');
    if (!actor.ok) return actor;
    if (!input.note.trim()) return err(new ValidationError('note is required'));

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const human = await this.deps.directory.find(tx, input.humanActorId);
      if (!human) return err(new NotFoundError('actor', input.humanActorId));
      if (human.type !== 'human') {
        return err(new PermissionError('escalation target must be a human actor', { target: human.id }));
      }

      const now = this.deps.clock.now();
      task.comments.push({
        id: this.deps.ids.next(),
        taskId: task.id,
        authorId: actor.value.id,
        kind: 'escalation',
        body: input.note.trim(),
        runId: input.runId,
        createdAt: now,
      });
      task.assigneeId = human.id;
      task.record({
        type: 'CommentAdded',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: now,
        payload: { kind: 'escalation', body: input.note.trim(), handoffTo: human.id },
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
