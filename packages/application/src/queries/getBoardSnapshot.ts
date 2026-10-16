import type { AppError, BoardId, Result } from '@agentboard/shared';
import { err, ok, NotFoundError } from '@agentboard/shared';
import type { Tx } from '@agentboard/domain';
import type { CallContext } from '../context.js';
import type { Deps } from '../deps.js';
import { Authorizer } from '../services/authorizer.js';
import { toTaskSummary, type TaskSummary } from './map.js';

export interface ColumnSnapshot {
  stateId: string;
  name: string;
  category: string;
  isHumanGate: boolean;
  wipLimit: number | null;
  count: number;
  tasks: TaskSummary[];
}

export interface BoardSnapshot {
  board: { id: string; name: string; slug: string };
  workflow: {
    id: string;
    name: string;
    states: Array<{ id: string; name: string; category: string; isHumanGate: boolean; wipLimit: number | null }>;
    transitions: Array<{
      id: string;
      from: string;
      to: string;
      name: string;
      allowedRoles: string[];
      requiredFields: string[];
    }>;
  };
  columns: ColumnSnapshot[];
}

export class GetBoardSnapshot {
  constructor(private readonly deps: Deps, private readonly authorizer: Authorizer) {}

  async execute(input: CallContext & { boardId: BoardId }): Promise<Result<BoardSnapshot, AppError>> {
    const actor = await this.authorizer.requireScope(input, 'read');
    if (!actor.ok) return actor;

    return this.deps.uow.run(async (tx: Tx) => {
      const board = await this.deps.boards.findById(tx, input.boardId);
      if (!board) return err(new NotFoundError('board', input.boardId));

      const workflow = await this.deps.workflows.findByBoard(tx, input.boardId);
      if (!workflow) return err(new NotFoundError('workflow', input.boardId));

      const page = await this.deps.tasks.query(tx, { boardId: board.id, limit: 200 });
      const now = this.deps.clock.now();

      const columns: ColumnSnapshot[] = workflow.orderedStates().map((state) => {
        const tasks = page.items.filter((t) => t.statusId === state.id);
        return {
          stateId: state.id,
          name: state.name,
          category: state.category,
          isHumanGate: state.isHumanGate,
          wipLimit: state.wipLimit,
          count: tasks.length,
          tasks: tasks.map((t) => toTaskSummary(t, workflow, now)),
        };
      });

      return ok({
        board: { id: board.id, name: board.name, slug: board.slug },
        workflow: {
          id: workflow.id,
          name: workflow.name,
          states: workflow.orderedStates().map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            isHumanGate: s.isHumanGate,
            wipLimit: s.wipLimit,
          })),
          transitions: workflow.transitions.map((t) => ({
            id: t.id,
            from: t.from,
            to: t.to,
            name: t.name,
            allowedRoles: [...t.allowedRoles],
            requiredFields: [...t.requiredFields],
          })),
        },
        columns,
      });
    });
  }
}
