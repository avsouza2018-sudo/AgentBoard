import type { ApiClient } from './api.js';
import type {
  ApiError,
  BoardSnapshot,
  ColumnSnapshot,
  Outcome,
  StateView,
  TaskAggregate,
  TaskSummary,
  TransitionView,
} from './contract.js';
import type { Frame } from './live.js';

export interface PendingMove {
  taskId: string;
  fromStateId: string;
  toStateId: string;
  reason: string;
}

export interface FeedItem {
  id: string | null;
  event: string;
  taskId: string | null;
  actorId: string | null;
  runId: string | null;
  at: string;
  data: Record<string, unknown>;
}

/** A card as the page shows it: the server's shape plus what this client currently believes. */
export interface CardView extends TaskSummary {
  pending: boolean;
  refusal: ApiError | null;
}

export interface ColumnView extends Omit<ColumnSnapshot, 'tasks'> {
  cards: CardView[];
}

export interface BoardView {
  board: BoardSnapshot['board'] | null;
  workflow: BoardSnapshot['workflow'] | null;
  columns: ColumnView[];
  feed: FeedItem[];
  pending: number;
  connected: boolean;
}

/**
 * The board state for the page.
 *
 * Two rules decide everything here, and both are about who is allowed to be wrong:
 *
 * 1. A move is optimistic — the card moves the moment it is asked, because a board that waits for
 *    the domain is unusable when an agent is working on the same card. The card carries `pending`
 *    until the answer arrives.
 * 2. A refusal rolls back to the *server*, not to the picture the client had before the click.
 *    Between the click and the refusal another agent may have moved the same card, so restoring the
 *    pre-click view would restore a guess. Re-reading is the only honest rollback, and the test that
 *    matters proves exactly that.
 *
 * The store never decides whether a move is legal. It sends the target column and the reason; the
 * answer is the aggregate or a refusal. Legality lives in the domain.
 */
export class BoardStore {
  private snapshot: BoardSnapshot | null = null;
  private readonly pending = new Map<string, PendingMove>();
  private readonly refusals = new Map<string, ApiError>();
  private feed: FeedItem[] = [];
  private connected = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: ApiClient, private readonly boardId: string) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get view(): BoardView {
    const snapshot = this.snapshot;
    const cards = new Map<string, CardView>();

    for (const column of snapshot?.columns ?? []) {
      for (const task of column.tasks) {
        cards.set(task.id, {
          ...task,
          pending: this.pending.has(task.id),
          refusal: refusalsOf(this.refusals, task.id),
        });
      }
    }

    for (const move of this.pending.values()) {
      const card = cards.get(move.taskId);
      if (!card) continue;
      card.statusId = move.toStateId;
      card.statusName = nameOf(snapshot?.workflow.states ?? [], move.toStateId);
      card.pending = true;
    }

    const columns: ColumnView[] = (snapshot?.columns ?? []).map((column) => ({
      stateId: column.stateId,
      name: column.name,
      category: column.category,
      isHumanGate: column.isHumanGate,
      wipLimit: column.wipLimit,
      count: column.count,
      cards: [...cards.values()].filter((card) => card.statusId === column.stateId),
    }));

    return {
      board: snapshot?.board ?? null,
      workflow: snapshot?.workflow ?? null,
      columns,
      feed: this.feed,
      pending: this.pending.size,
      connected: this.connected,
    };
  }

  async load(): Promise<Outcome<BoardSnapshot>> {
    const outcome = await this.api.board(this.boardId);
    if (outcome.ok) this.snapshot = outcome.data;
    this.emit();
    return outcome;
  }

  async move(taskId: string, toStateId: string, reason: string, forceReason?: string): Promise<Outcome<void>> {
    const card = this.findTask(taskId);
    this.pending.set(taskId, { taskId, fromStateId: card?.statusId ?? '', toStateId, reason });
    this.emit();

    const outcome = await this.api.move({
      task_id: taskId,
      to_state_id: toStateId,
      reason,
      ...(forceReason !== undefined ? { force_reason: forceReason } : {}),
    });

    this.pending.delete(taskId);

    if (outcome.ok) {
      // The response is the aggregate a committed transaction wrote, so adopting it is not a guess.
      this.refusals.delete(taskId);
      this.adopt(outcome.data);
    } else {
      this.refusals.set(taskId, outcome.error);
      await this.reload();
    }

    this.emit();

    return outcome.ok ? { ok: true, data: undefined } : { ok: false, error: outcome.error };
  }

  /**
   * A frame is something a committed transaction wrote — that is the promise the outbox gives.
   * It is recorded even when it cannot move a card: a card that is still in flight belongs to the
   * call that is waiting for its answer, so the frame goes to the feed and the card stays put.
   */
  applyFrame(frame: Frame): void {
    if (frame.event === 'connected') {
      this.connected = true;
      this.emit();
      return;
    }

    if (frame.event === 'disconnected') {
      this.connected = false;
      this.emit();
      return;
    }

    const taskId = typeof frame.data.aggregateId === 'string' ? frame.data.aggregateId : null;

    this.feed.push({
      id: frame.id,
      event: frame.event,
      taskId,
      actorId: typeof frame.data.actorId === 'string' ? frame.data.actorId : null,
      runId: typeof frame.data.runId === 'string' ? frame.data.runId : null,
      at: typeof frame.data.at === 'string' ? frame.data.at : '',
      data: frame.data,
    });

    if (this.feed.length > 200) this.feed.shift();

    const card = taskId ? this.findTask(taskId) : undefined;
    const payload = (frame.data.payload as Record<string, unknown> | undefined) ?? {};

    if (taskId && card && !this.pending.has(taskId) && frame.event === 'TaskMoved' && typeof payload.to === 'string') {
      card.statusId = payload.to;
      card.statusName = nameOf(this.snapshot?.workflow.states ?? [], payload.to);
    }

    this.emit();
  }

  /** The graph as the server described it. Rendering it is not the same as deciding who may use it. */
  transitionsFrom(stateId: string): TransitionView[] {
    return (this.snapshot?.workflow.transitions ?? []).filter((t) => t.from === stateId);
  }

  /** The stored task, not the copy the page renders: mutating the copy would be lost on the next paint. */
  private adopt(aggregate: TaskAggregate): void {
    const card = this.findTask(aggregate.id);
    if (!card) return;

    card.key = aggregate.key;
    card.title = aggregate.title;
    card.statusId = aggregate.statusId;
    card.statusName = nameOf(this.snapshot?.workflow.states ?? [], aggregate.statusId);
    card.priority = aggregate.priority;
    card.assigneeId = aggregate.assigneeId;
    card.labels = aggregate.labels;
    card.blockedBy = aggregate.blockedBy;
    card.version = aggregate.version;
    card.updatedAt = aggregate.updatedAt;
    card.lease = aggregate.lease ? { agentId: aggregate.lease.agentId, expiresAt: aggregate.lease.expiresAt } : null;
  }

  private async reload(): Promise<void> {
    const outcome = await this.api.board(this.boardId);
    if (outcome.ok) this.snapshot = outcome.data;
  }

  private findTask(taskId: string): TaskSummary | undefined {
    for (const column of this.snapshot?.columns ?? []) {
      const task = column.tasks.find((t) => t.id === taskId);
      if (task) return task;
    }
    return undefined;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function nameOf(states: StateView[], stateId: string): string {
  return states.find((s) => s.id === stateId)?.name ?? stateId;
}

function refusalsOf(refusals: Map<string, ApiError>, taskId: string): ApiError | null {
  return refusals.get(taskId) ?? null;
}
