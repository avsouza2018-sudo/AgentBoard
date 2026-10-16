import type { AppError, ErrorCode, ErrorDetails, Result } from '@agentboard/shared';

/**
 * The transport-neutral shape of one tool call.
 *
 * Every failure that reaches an adapter is already an `AppError` with a `code`, so the
 * adapters do not classify anything — they only render. `code` is the same string an HTTP
 * client would see, and `details` is the same object. Both transports render this one type;
 * neither is allowed to invent its own error shape. The parity test is what keeps that true.
 */
export interface ToolError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: ErrorDetails;
  readonly retryable: boolean;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: ToolError };

export function toToolError(error: AppError): ToolError {
  return { code: error.code, message: error.message, details: error.details, retryable: error.retryable };
}

export function outcomeOf<T>(result: Result<T, AppError>): ToolOutcome {
  return result.ok ? { ok: true, data: result.value } : { ok: false, error: toToolError(result.error) };
}
