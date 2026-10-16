import type { Pool, PoolClient } from 'pg';
import type { Tx, UnitOfWork } from '@agentboard/domain';
import type { PgTx } from './tx.js';

/**
 * One unit of work is one database transaction: every repository call inside `run` shares the
 * same connection, so the aggregate write, the audit row, and the outbox row commit together or
 * none of them do.
 *
 * Rollback happens on a thrown error. Commands return `Result` instead of throwing, and they
 * evaluate policy before mutating anything, so an unsuccessful command writes nothing and has
 * nothing to roll back. That ordering is the reason this is safe.
 */
export class PgUnitOfWork implements UnitOfWork {
  private counter = 0;

  constructor(private readonly pool: Pool) {}

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    this.counter += 1;
    const tx: PgTx = { label: `pg:${this.counter}`, client };

    try {
      await client.query('begin');
      const result = await work(tx);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
