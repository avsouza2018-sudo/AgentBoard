import type { BoardId } from '@agentboard/shared';
import type { Board, BoardRepository, Tx, Workflow, WorkflowRepository } from '@agentboard/domain';
import type { PoolClient } from 'pg';
import type { BoardRow, MembershipRow, StateRow, TransitionRow, WorkflowRow } from './mapper.js';
import { boardFromRow, workflowFromRow } from './mapper.js';
import { clientOf } from './tx.js';

export class PgBoardRepository implements BoardRepository {
  async findById(tx: Tx, boardId: BoardId): Promise<Board | null> {
    const client = clientOf(tx);
    const board = await client.query<BoardRow>('select id, name, slug, workflow_id from boards where id = $1', [boardId]);
    const row = board.rows[0];
    if (!row) return null;

    const members = await client.query<MembershipRow>(
      'select actor_id, role from board_members where board_id = $1 order by actor_id',
      [boardId],
    );
    return boardFromRow(row, members.rows);
  }

  async list(tx: Tx): Promise<Board[]> {
    const client = clientOf(tx);
    const boards = await client.query<BoardRow>('select id, name, slug, workflow_id from boards order by name');
    return Promise.all(
      boards.rows.map(async (row) => {
        const members = await client.query<MembershipRow>(
          'select actor_id, role from board_members where board_id = $1 order by actor_id',
          [row.id],
        );
        return boardFromRow(row, members.rows);
      }),
    );
  }

  /**
   * The roster is decided by the aggregate, so this writes what the aggregate decided instead of
   * deciding it. A grant and a role change are the same statement here because they are the same act
   * in the domain.
   */
  async save(tx: Tx, board: Board): Promise<void> {
    const client = clientOf(tx);

    await client.query(
      `insert into boards (id, name, slug, workflow_id) values ($1, $2, $3, $4)
       on conflict (id) do update set name = excluded.name, slug = excluded.slug, workflow_id = excluded.workflow_id`,
      [board.id, board.name, board.slug, board.workflowId],
    );

    for (const membership of board.members) {
      await client.query(
        `insert into board_members (board_id, actor_id, role) values ($1, $2, $3)
         on conflict (board_id, actor_id) do update set role = excluded.role`,
        [board.id, membership.actorId, membership.role],
      );
    }
  }
}

export class PgWorkflowRepository implements WorkflowRepository {
  async findByBoard(tx: Tx, boardId: BoardId): Promise<Workflow | null> {
    const client = clientOf(tx);
    const workflows = await client.query<WorkflowRow>('select id, board_id, name from workflows where board_id = $1', [boardId]);
    const row = workflows.rows[0];
    if (!row) return null;

    const states = await client.query<StateRow>(
      `select id, name, category, is_human_gate, wip_limit, "order" from workflow_states where workflow_id = $1 order by "order"`,
      [row.id],
    );
    const transitions = await client.query<TransitionRow>(
      'select id, from_state, to_state, name, allowed_roles, required_fields from workflow_transitions where workflow_id = $1 order by id',
      [row.id],
    );

    return workflowFromRow(row, states.rows, transitions.rows);
  }
}
