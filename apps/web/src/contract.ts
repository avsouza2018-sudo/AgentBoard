/**
 * What the browser knows about the API. Hand-written on purpose.
 *
 * The web app is a client of the HTTP contract, not a consumer of the domain package. If `apps/web`
 * imported `@agentboard/domain`, the UI would start depending on aggregate classes — and the rule
 * `web-consumes-the-contract-only` in `.dependency-cruiser.cjs` fails the build when it happens.
 *
 * Two asymmetries are recorded here because they are real, not because they are tidy:
 *   arguments go out in snake_case (the tool schema), results come back in camelCase;
 *   reads return DTOs, writes return the aggregate as serialised.
 *
 * The field lists are exported as values, not only as types, because a type cannot be checked at
 * runtime and a list of names can. The client test compares them against the JSON a live server
 * actually sends — that is what catches the UI drifting from the surface it is supposed to consume.
 */

export type Outcome<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** The error body exactly as the contract documents it. The client adds nothing to it. */
export interface ApiError {
  code: string;
  message: string;
  details: Record<string, unknown>;
  retryable: boolean;
}

/**
 * A lease as the server reports it. `status` is the domain's word — `none | held | expiring | expired` —
 * not the page's. The same policy that refuses a `result` comment on an expired lease is what names
 * `expiring` here, so the board and the page cannot disagree about the same card. A page that decided
 * "this lease looks stale" would be a second definition of staleness, and the second definition is the
 * one that drifts.
 *
 * `status` is null only when the shape came from a write response. A write returns the aggregate, and
 * the aggregate carries a lease but not a status — a status is a fact about the moment a read happened,
 * so only the read model can carry it. The page shows no word in that case rather than inventing one.
 */
export type LeaseStatus = 'none' | 'held' | 'expiring' | 'expired';

export interface LeaseView {
  agentId: string;
  expiresAt: string;
  status: LeaseStatus | null;
}

export interface TaskSummary {
  id: string;
  key: string;
  title: string;
  statusId: string;
  statusName: string;
  priority: string;
  assigneeId: string | null;
  labels: string[];
  blockedBy: string[];
  lease: LeaseView | null;
  version: number;
  updatedAt: string;
}

/** What a write tool returns: the aggregate, serialised. Different shape from the read DTO. */
export interface TaskAggregate {
  id: string;
  boardId: string;
  key: string;
  title: string;
  description: string;
  statusId: string;
  priority: string;
  assigneeId: string | null;
  reporterId: string;
  labels: string[];
  blockedBy: string[];
  acceptanceCriteria: string[];
  comments: CommentDto[];
  lease: { taskId: string; agentId: string; acquiredAt: string; expiresAt: string; renewCount: number } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommentDto {
  id: string;
  authorId: string;
  kind: string;
  body: string;
  runId: string | null;
  createdAt: string;
}

export interface ActivityDto {
  id: string;
  type: string;
  actorId: string;
  runId: string | null;
  at: string;
  payload: Record<string, unknown>;
}

export interface StateView {
  id: string;
  name: string;
  category: string;
  isHumanGate: boolean;
  wipLimit: number | null;
}

export interface TransitionView {
  id: string;
  from: string;
  to: string;
  name: string;
  allowedRoles: string[];
  requiredFields: string[];
}

export interface ColumnSnapshot {
  stateId: string;
  name: string;
  category: string;
  isHumanGate: boolean;
  wipLimit: number | null;
  count: number;
  tasks: TaskSummary[];
}

export interface BoardSnapshot {
  board: { id: string; name: string; slug: string };
  workflow: { id: string; name: string; states: StateView[]; transitions: TransitionView[] };
  columns: ColumnSnapshot[];
}

export interface TaskDetail {
  task: TaskSummary;
  description: string;
  acceptanceCriteria: string[];
  comments: CommentDto[];
  recentActivity: ActivityDto[];
}

export interface Identity {
  actor: { id: string; type: string; name: string; scopes: string[] };
  boards: Array<{ id: string; name: string; slug: string; role: string }>;
}

/**
 * A principal as the roster reports it. `registeredBy` is the fact the audit trail cannot answer: the
 * trail says which token moved a card, the registry says who minted that token. `held` is the lease the
 * server still considered live at the moment it answered — the page does not decide that.
 */
export interface AgentView {
  id: string;
  type: string;
  name: string;
  role: string;
  scopes: string[];
  registeredBy: string | null;
  held: TaskSummary[];
  lastActivityAt: string | null;
}

export interface Page<T> {
  items: T[];
  cursor: string | null;
}

/**
 * The operations the client calls, as the contract states them: a name, a method, a path template.
 * `tests/web/client.test.ts` checks every one of them against the generated OpenAPI document, so a
 * path the page invents is caught. The live feed is the single exception, because it is served by the
 * adapter rather than generated from a tool definition.
 */
export const OPERATIONS = {
  me: { method: 'GET', path: '/api/me' },
  board: { method: 'GET', path: '/api/boards/{board_id}' },
  listTasks: { method: 'GET', path: '/api/boards/{board_id}/tasks' },
  createTask: { method: 'POST', path: '/api/boards/{board_id}/tasks' },
  activity: { method: 'GET', path: '/api/boards/{board_id}/activity' },
  agents: { method: 'GET', path: '/api/boards/{board_id}/agents' },
  task: { method: 'GET', path: '/api/tasks/{task_id}' },
  move: { method: 'POST', path: '/api/tasks/{task_id}/move' },
  claim: { method: 'POST', path: '/api/tasks/{task_id}/claim' },
  release: { method: 'POST', path: '/api/tasks/{task_id}/release' },
  comment: { method: 'POST', path: '/api/tasks/{task_id}/comments' },
  events: { method: 'GET', path: '/api/boards/{board_id}/events' },
} as const;

/**
 * Runtime copies of the shapes above. A type cannot be checked at runtime; a list of names can, so
 * the client test compares these against the JSON a live server actually sends. That is what catches
 * the mirror drifting from the surface it mirrors.
 */
export const FIELDS = {
  taskSummary: ['id', 'key', 'title', 'statusId', 'statusName', 'priority', 'assigneeId', 'labels', 'blockedBy', 'lease', 'version', 'updatedAt'],
  taskAggregate: ['id', 'boardId', 'key', 'title', 'description', 'statusId', 'priority', 'assigneeId', 'reporterId', 'labels', 'blockedBy', 'acceptanceCriteria', 'comments', 'lease', 'version', 'createdAt', 'updatedAt'],
  comment: ['id', 'authorId', 'kind', 'body', 'runId', 'createdAt'],
  activity: ['id', 'type', 'actorId', 'runId', 'at', 'payload'],
  lease: ['agentId', 'expiresAt', 'status'],
  agent: ['id', 'type', 'name', 'role', 'scopes', 'registeredBy', 'held', 'lastActivityAt'],
  error: ['code', 'message', 'details', 'retryable'],
  response: ['data'],
} as const;

export function fill(template: string, args: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => args[name] ?? '');
}
