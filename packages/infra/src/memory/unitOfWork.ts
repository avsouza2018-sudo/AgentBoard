import type { Tx, UnitOfWork } from '@agentboard/domain';

/**
 * In-memory stand-in for a real transaction. Faithful enough for use-case tests: it hands
 * the same handle to every repository call in one unit of work.
 */
export class MemoryUnitOfWork implements UnitOfWork {
  private counter = 0;

  async run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    this.counter += 1;
    return work({ label: `tx:${this.counter}` });
  }
}
