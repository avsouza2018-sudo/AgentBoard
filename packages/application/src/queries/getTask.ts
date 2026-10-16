import type { AppError, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { toActivityDto, toCommentDto, toTaskSummary, type ActivityDto, type CommentDto, type TaskSummary } from './map.js';

export interface TaskDetail {
  task: TaskSummary;
  description: string;
  acceptanceCriteria: string[];
  comments: CommentDto[];
  recentActivity: ActivityDto[];
}

export class GetTask {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(input: CallContext & { taskId: TaskId; activityLimit?: number }): Promise<Result<TaskDetail, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'read');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const task = await this.deps.tasks.findById(tx, input.taskId);
      if (!task) return err(new NotFoundError('task', input.taskId));

      const workflow = await this.deps.workflows.findByBoard(tx, task.boardId);
      if (!workflow) return err(new NotFoundError('workflow', task.boardId));

      const activity = await this.deps.activity.readForTask(tx, task.id, input.activityLimit ?? 20);

      return ok({
        task: toTaskSummary(task, workflow, this.deps.clock.now()),
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        comments: task.comments.map(toCommentDto),
        recentActivity: activity.map(toActivityDto),
      });
    });
  }
}
