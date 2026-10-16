import type { Tx } from '@agentboard/domain';
import type { TaskKeySequence } from '@agentboard/domain';
import type { PoolClient } from 'pg';
import { clientOf } from './tx.js';

/**
 * Board-scoped, monotonic, never reused.
 *
 * A Postgres SEQUENCE would satisfy "monotonic" but not the promise the domain makes: a sequence
 * advances even when the transaction that took the number rolls back, which leaves a key like
 * AG-7 attached to a task that was never created. This is a row updated inside the transaction,
 * so a rolled-back key is not burned. The `on conflict do update` also locks the row, which is
 * what serialises key generation across concurrent agents.
 */
export class PgTaskKeySequence implements TaskKeySequence {
  async next(tx: Tx, boardSlug: string): Promise<number> {
    const client = clientOf(tx);
    const res = await client.query<{ next_value: string | number }>(
      `insert into task_key_sequences (board_slug, next_value) values ($1, 1)
       on conflict (board_slug) do update set next_value = task_key_sequences.next_value + 1
       returning next_value`,
      [boardSlug],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`key sequence for board ${boardSlug} was not returned`);
    return Number(row.next_value);
  }
}
