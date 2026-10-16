import type { BoardId } from '@agentboard/shared';
import type { OutboxReader, OutboxRow } from '@agentboard/domain';

export interface StreamOptions {
  readonly limit?: number;
  readonly intervalMs?: number;
}

/**
 * The frame a client sees. Kept in one function so the server and the test agree on what a
 * delivered event is: `id` is the outbox row, `event` is the domain event type, `data` carries the
 * run that produced it — the same provenance the audit log records.
 */
export function sseFrame(row: OutboxRow): string {
  return `id: ${row.id}\nevent: ${row.event.type}\ndata: ${JSON.stringify({ ...row.event, runId: row.runId })}\n\n`;
}

/**
 * A live feed fed by the outbox, not by a hook inside the use case.
 *
 * The difference matters: a hook fires when the code reaches the point of publishing, which is
 * before the transaction commits. A stream fed that way can announce a card that never existed.
 * Reading the outbox means every frame is something a committed transaction wrote.
 *
 * Dispatch runs after the request's transaction has committed, plus on an interval so a writer in
 * another process is still visible.
 */
export class OutboxStream {
  private readonly subscribers = new Map<string, { boardId: BoardId; send: (frame: string) => void }>();
  private sequence = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly outbox: OutboxReader, private readonly options: StreamOptions = {}) {}

  subscribe(boardId: BoardId, send: (frame: string) => void): { readonly id: string; unsubscribe(): void } {
    const id = `sub-${(this.sequence += 1)}`;
    this.subscribers.set(id, { boardId, send });
    return { id, unsubscribe: () => this.subscribers.delete(id) };
  }

  /** Fan out the rows that were written since the last dispatch, to the boards that can see them. */
  async dispatch(): Promise<number> {
    const rows = await this.outbox.drain(this.options.limit ?? 100);

    for (const row of rows) {
      const frame = sseFrame(row);
      for (const sub of this.subscribers.values()) {
        if (sub.boardId === row.event.boardId) sub.send(frame);
      }
    }

    return rows.length;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatch();
    }, this.options.intervalMs ?? 250);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get connections(): number {
    return this.subscribers.size;
  }
}
