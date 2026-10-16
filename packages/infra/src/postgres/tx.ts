import type { Tx } from '@agentboard/domain';
import type { PoolClient } from 'pg';

/**
 * The domain port passes an opaque `Tx`. A Postgres repository needs a connection, so the
 * Postgres unit of work hands out a transaction that also carries one.
 *
 * The cast is checked rather than assumed: pairing a Postgres repository with the in-memory
 * unit of work is a wiring mistake, and it should fail with a message that says so instead of
 * silently writing to the wrong store.
 */
export interface PgTx extends Tx {
  readonly client: PoolClient;
}

export function clientOf(tx: Tx): PoolClient {
  const candidate = tx as Partial<PgTx>;
  if (!candidate?.client) {
    throw new Error(
      `Postgres adapter received a non-Postgres transaction (${tx.label}). ` +
        'Pair these repositories with PgUnitOfWork.',
    );
  }
  return candidate.client;
}
