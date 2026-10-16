import type { TaskKeySequence, Tx } from '@agentboard/domain';

export class InMemoryTaskKeySequence implements TaskKeySequence {
  private counters = new Map<string, number>();

  async next(_tx: Tx, boardSlug: string): Promise<number> {
    const n = (this.counters.get(boardSlug) ?? 0) + 1;
    this.counters.set(boardSlug, n);
    return n;
  }
}
