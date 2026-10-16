import type { BoardId } from '@agentboard/shared';
import type { Board } from '../model/board.js';
import type { Workflow } from '../model/workflow.js';
import type { Tx } from './unitOfWork.js';

export interface BoardRepository {
  findById(tx: Tx, id: BoardId): Promise<Board | null>;
  list(tx: Tx): Promise<Board[]>;
  /** The aggregate is the only place the roster is decided, so the repository takes it as it is. */
  save(tx: Tx, board: Board): Promise<void>;
}

export interface WorkflowRepository {
  findByBoard(tx: Tx, boardId: BoardId): Promise<Workflow | null>;
}
