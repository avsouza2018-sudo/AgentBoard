import type { Board, Membership, Tx, Workflow, WorkflowRepository, BoardRepository } from '@agentboard/domain';
import { id, type BoardId } from '@agentboard/shared';
import { Board as BoardModel, Workflow as WorkflowModel } from '@agentboard/domain';

export class InMemoryBoardRepository implements BoardRepository {
  private boards = new Map<BoardId, Board>();

  async add(board: Board): Promise<void> {
    this.boards.set(board.id, board);
  }

  async findById(_tx: Tx, boardId: BoardId): Promise<Board | null> {
    return this.boards.get(boardId) ?? null;
  }

  async list(_tx: Tx): Promise<Board[]> {
    return [...this.boards.values()];
  }

  async save(_tx: Tx, board: Board): Promise<void> {
    this.boards.set(board.id, board);
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private byBoard = new Map<BoardId, Workflow>();

  async add(workflow: Workflow): Promise<void> {
    this.byBoard.set(workflow.boardId, workflow);
  }

  async findByBoard(_tx: Tx, boardId: BoardId): Promise<Workflow | null> {
    return this.byBoard.get(boardId) ?? null;
  }
}

export function makeBoard(boardId: string, slug: string, name: string, members: Membership[]): Board {
  return new BoardModel({
    id: id<BoardId>(boardId),
    name,
    slug,
    workflowId: `wf-${boardId}`,
    members,
  });
}

export function makeWorkflow(boardId: string, name: string, states: Workflow['states'], transitions: Workflow['transitions']): Workflow {
  return new WorkflowModel({ id: `wf-${boardId}`, boardId: id<BoardId>(boardId), name, states, transitions });
}
