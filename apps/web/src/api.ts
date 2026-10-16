import { fill, OPERATIONS, type ActivityDto, type AgentView, type ApiError, type BoardSnapshot, type Identity, type Outcome, type Page, type TaskAggregate, type TaskDetail, type TaskSummary } from './contract.js';

export interface ClientOptions {
  readonly baseUrl: string;
  /** A token is an identity, not a session cookie: it resolves to an `Actor` on the server. */
  readonly token: string;
  /** Provenance. A write with no run is refused by the tool layer, so the browser must have one. */
  readonly runId: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The client. It does three things: build a path from the contract's operation table, send the token
 * and the run id, and read the body as the contract documents it.
 *
 * It does not classify. A `403` is not turned into "forbidden" here and a `409` is not turned into
 * "conflict" — the body already carries `code`, `message`, and `retryable`, produced by the same
 * table the MCP adapter renders through. A client that re-derived the meaning of a status code would
 * be a second taxonomy, and it would be the first place the UI disagreed with an agent.
 */
export class ApiClient {
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  identity(): Promise<Outcome<Identity>> {
    return this.call<Identity>('me');
  }

  board(boardId: string): Promise<Outcome<BoardSnapshot>> {
    return this.call<BoardSnapshot>('board', { board_id: boardId });
  }

  listTasks(boardId: string, filter: Record<string, string> = {}): Promise<Outcome<Page<TaskSummary>>> {
    return this.call<Page<TaskSummary>>('listTasks', { board_id: boardId }, filter);
  }

  createTask(boardId: string, body: Record<string, unknown>): Promise<Outcome<TaskAggregate>> {
    return this.call<TaskAggregate>('createTask', { board_id: boardId }, body);
  }

  activity(boardId: string, filter: Record<string, string> = {}): Promise<Outcome<ActivityDto[]>> {
    return this.call<ActivityDto[]>('activity', { board_id: boardId }, filter);
  }

  /** The roster, read as the server answered it — including who minted each credential. */
  agents(boardId: string): Promise<Outcome<AgentView[]>> {
    return this.call<AgentView[]>('agents', { board_id: boardId });
  }

  task(taskId: string): Promise<Outcome<TaskDetail>> {
    return this.call<TaskDetail>('task', { task_id: taskId });
  }

  /**
   * A move is a guarded transition, not an edit: the body carries `reason`, because the audit trail
   * requires it. The client never checks whether the move is legal — it asks, and the answer is the
   * aggregate or a refusal.
   */
  move(args: { task_id: string; to_state_id: string; reason: string; force_reason?: string }): Promise<Outcome<TaskAggregate>> {
    return this.call<TaskAggregate>('move', { task_id: args.task_id }, args);
  }

  claim(taskId: string, reason?: string): Promise<Outcome<TaskAggregate>> {
    return this.call<TaskAggregate>('claim', { task_id: taskId }, { task_id: taskId, ...(reason !== undefined ? { reason } : {}) });
  }

  release(taskId: string): Promise<Outcome<TaskAggregate>> {
    return this.call<TaskAggregate>('release', { task_id: taskId }, { task_id: taskId });
  }

  comment(taskId: string, kind: string, body: string): Promise<Outcome<TaskAggregate>> {
    return this.call<TaskAggregate>('comment', { task_id: taskId }, { task_id: taskId, kind, body });
  }

  /** The live feed, from the same operation table the rest of the client uses. */
  eventsUrl(boardId: string): string {
    return `${this.options.baseUrl}${fill(OPERATIONS.events.path, { board_id: boardId })}`;
  }

  private async call<T>(
    name: keyof typeof OPERATIONS,
    pathArgs: Record<string, string> = {},
    extra: Record<string, unknown> | undefined = undefined,
  ): Promise<Outcome<T>> {
    const operation = OPERATIONS[name];
    const path = fill(operation.path, pathArgs);
    let url = `${this.options.baseUrl}${path}`;

    const init: RequestInit = {
      method: operation.method,
      headers: { authorization: `Bearer ${this.options.token}`, 'x-run-id': this.options.runId },
    };

    if (operation.method === 'POST') {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(extra ?? {});
    } else if (extra && Object.keys(extra).length > 0) {
      url += `?${new URLSearchParams(Object.entries(extra).map(([k, v]) => [k, String(v)])).toString()}`;
    }

    const response = await this.fetchImpl(url, init);
    const payload = (await response.json().catch(() => null)) as { data?: T; error?: ApiError } | null;

    if (response.ok) return { ok: true, data: payload?.data as T };

    // The client reads the code the server chose. The only value it ever produces itself is this
    // one, and it is not a domain code — it means the server did not answer with the documented
    // shape, which is a fact about the transport, not about the board.
    return {
      ok: false,
      error:
        payload?.error ?? {
          code: 'no_error_body',
          message: `no error body for ${operation.method} ${path}`,
          details: { path },
          retryable: true,
        },
    };
  }
}
