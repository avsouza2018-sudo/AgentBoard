import type { AppError, BoardId, Result, TaskId } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { toActivityDto, type ActivityDto } from './map.js';

export class GetActivity {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(
    input: CallContext & { boardId: BoardId; taskId?: TaskId; limit?: number },
  ): Promise<Result<ActivityDto[], AppError>> {
    const actor = await this.authorizer.requireScope(input, 'read');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const board = await this.deps.boards.findById(tx, input.boardId);
      if (!board) return err(new NotFoundError('board', input.boardId));

      const rows = input.taskId
        ? await this.deps.activity.readForTask(tx, input.taskId, input.limit ?? 20)
        : await this.deps.activity.readForBoard(tx, board.id, input.limit ?? 50);

      return ok(rows.map(toActivityDto));
    });
  }
}
