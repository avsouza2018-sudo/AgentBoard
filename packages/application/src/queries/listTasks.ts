import type { AppError, BoardId, Result } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Page, TaskFilter, Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { toTaskSummary, type TaskSummary } from './map.js';

export class ListTasks {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(
    input: CallContext & { boardId: BoardId; filter: Omit<TaskFilter, 'boardId'> },
  ): Promise<Result<Page<TaskSummary>, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'read');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const workflow = await this.deps.workflows.findByBoard(tx, input.boardId);
      if (!workflow) return err(new NotFoundError('workflow', input.boardId));

      const page = await this.deps.tasks.query(tx, { boardId: input.boardId, ...input.filter });
      return ok({ items: page.items.map((t) => toTaskSummary(t, workflow)), cursor: page.cursor });
    });
  }
}
