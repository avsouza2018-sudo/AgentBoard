import type { BoardId } from '@agentboard/shared';
import type { Tx } from './unitOfWork.js';

/** Board-scoped, monotonic, never reused. Backed by a sequence table in Postgres. */
export interface TaskKeySequence {
  next(tx: Tx, boardSlug: string): Promise<number>;
}
