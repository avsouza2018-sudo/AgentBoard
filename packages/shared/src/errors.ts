/**
 * Single error taxonomy for the whole system.
 *
 * The domain and application return these; the HTTP adapter maps `code` to a status
 * and the MCP adapter maps `code` to `isError` content. Both read from this file, so
 * an agent and a browser see the same failure for the same reason.
 */
export type ErrorCode =
  | 'validation'
  | 'not_found'
  | 'permission'
  | 'transition_not_allowed'
  | 'wip_limit'
  | 'blocked'
  | 'human_gate'
  | 'lease_required'
  | 'lease_expired'
  | 'concurrency'
  | 'conflict'
  | 'cycle'
  | 'rate_limited'
  | 'method_not_allowed';

export interface ErrorDetails {
  [key: string]: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, details: ErrorDetails = {}, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('validation', message, details, false);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`, { entity, id }, false);
  }
}

export class PermissionError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('permission', message, details, false);
  }
}

/**
 * The one code in the taxonomy that an adapter produces rather than the domain: the router knows
 * the path exists but not under the method used. It goes through the same table, so the HTTP
 * surface does not get its own error shape — which is the whole point of keeping one taxonomy.
 */
export class MethodNotAllowedError extends AppError {
  constructor(path: string, servedAs: string) {
    super('method_not_allowed', `${path} is served as ${servedAs}`, { path, servedAs }, false);
  }
}

export class TransitionNotAllowedError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('transition_not_allowed', message, details, false);
  }
}

export class WipLimitError extends AppError {
  constructor(state: string, limit: number, occupants: string[]) {
    super('wip_limit', `${state} is full (limit ${limit})`, { state, limit, occupants }, false);
  }
}

export class BlockedError extends AppError {
  constructor(blockers: string[]) {
    super('blocked', `task is blocked by open tasks: ${blockers.join(', ')}`, { blockers }, false);
  }
}

export class HumanGateError extends AppError {
  constructor(state: string) {
    super('human_gate', `state ${state} requires human approval; agents cannot enter it`, { state }, false);
  }
}

export class LeaseRequiredError extends AppError {
  constructor(action: string) {
    super('lease_required', `action '${action}' requires holding the task lease`, { action }, false);
  }
}

export class LeaseExpiredError extends AppError {
  constructor(taskId: string, holder: string) {
    super('lease_expired', `lease on ${taskId} expired (holder ${holder})`, { taskId, holder }, false);
  }
}

export class ConcurrencyError extends AppError {
  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(
      'concurrency',
      `task ${taskId} changed while this operation was running`,
      { taskId, expectedVersion, actualVersion },
      true,
    );
  }
}

export class LeaseConflictError extends AppError {
  constructor(taskId: string, holder: string, expiresAt: Date) {
    super(
      'conflict',
      `lease on ${taskId} is held by ${holder} until ${expiresAt.toISOString()}`,
      { taskId, holder, expiresAt: expiresAt.toISOString() },
      true,
    );
  }
}

export class CycleError extends AppError {
  constructor(cycle: string[]) {
    super('cycle', `dependency cycle: ${cycle.join(' -> ')}`, { cycle }, false);
  }
}

/**
 * The only code in the taxonomy that carries a time, and the field is named `retryAfter` because that
 * is the name the HTTP renderer reads to build the `retry-after` header. One name, in one taxonomy:
 * a limiter that wrote `retryAfterSeconds` would produce a refusal the transport could not render.
 */
export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super('rate_limited', `rate limited, retry in ${retryAfterSeconds}s`, { retryAfter: retryAfterSeconds }, true);
  }
}
