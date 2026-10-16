import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError, ValidationError } from '@agentboard/shared';
import { canComment } from '@agentboard/domain';
import type { CommentKind, Task, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { Recorder } from '../services/recorder.js';

export interface AddCommentInput extends CallContext {
  taskId: TaskId;
  kind: CommentKind;
  body: string;
}

export class AddComment {
  constructor(
    private readonly deps: Deps,
    private readonly authorizer: Authorizer,
    private readonly recorder: Recorder,
  ) {}

  async execute(input: AddCommentInput): Promise<Result<Task, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'comment');
    if (!actor.ok) return actor;
    if (!input.body.trim()) return err(new ValidationError('body is required'));

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const now = this.deps.clock.now();
      const allowed = canComment(task, actor.value, input.kind, now);
      if (!allowed.ok) return allowed;

      task.comments.push({
        id: this.deps.ids.next(),
        taskId: task.id,
        authorId: actor.value.id,
        kind: input.kind,
        body: input.body.trim(),
        runId: input.runId,
        createdAt: now,
      });

      task.record({
        type: 'CommentAdded',
        aggregateId: task.id,
        boardId: task.boardId,
        actorId: actor.value.id,
        at: now,
        payload: { kind: input.kind, body: input.body.trim() },
      });

      await this.deps.tasks.save(tx, task);
      await this.recorder.flush(tx, task, input.runId);
      return ok(task);
    });
  }
}
