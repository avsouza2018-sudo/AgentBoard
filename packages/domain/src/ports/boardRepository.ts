import type { BoardId } from '@agentboard/shared';
import type { Board } from '../model/board.js';
import type { Workflow } from '../model/workflow.js';
import type { Tx } from './unitOfWork.js';

export interface BoardRepository {
  findById(tx: Tx, id: BoardId): Promise<Board | null>;
  list(tx: Tx): Promise<Board[]>;
}

export interface WorkflowRepository {
  findByBoard(tx: Tx, boardId: BoardId): Promise<Workflow | null>;
}
