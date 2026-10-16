import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorCode } from '@agentboard/shared';
import type { ToolOutcome } from './toolOutcome.js';

/**
 * ErrorCode → HTTP status. One table, read by the HTTP adapter in M5.
 *
 * A code is a fact about why something failed; a status is how that fact is spoken over
 * HTTP. Keeping the table here — not inside a route handler — is what lets the contract
 * test assert that an agent and a browser are told the same thing.
 */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  validation: 400,
  not_found: 404,
  permission: 403,
  transition_not_allowed: 409,
  wip_limit: 409,
  blocked: 409,
  human_gate: 403,
  lease_required: 403,
  lease_expired: 409,
  concurrency: 409,
  conflict: 409,
  cycle: 409,
  rate_limited: 429,
  method_not_allowed: 405,
};

export function httpStatusFor(code: import('@agentboard/shared').ErrorCode): number {
  return HTTP_STATUS[code];
}

/** MCP rendering: text for a model to read, structuredContent for a client to parse. */
export function renderMcp(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.data) }],
      structuredContent: jsonRecord(outcome.data),
      isError: false,
    };
  }
  return {
    content: [{ type: 'text', text: `${outcome.error.code}: ${outcome.error.message}` }],
    structuredContent: { error: outcome.error },
    isError: true,
  };
}

export interface HttpResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export function renderHttp(outcome: ToolOutcome): HttpResponse {
  if (outcome.ok) {
    return { status: 200, body: { data: outcome.data }, headers: {} };
  }
  const headers: Record<string, string> = {};
  const retryAfter = outcome.error.details.retryAfter;
  if (typeof retryAfter === 'number') headers['retry-after'] = String(retryAfter);
  return { status: httpStatusFor(outcome.error.code), body: { error: outcome.error }, headers };
}

/**
 * `structuredContent` has to be a JSON record. A command returns a domain aggregate — a class
 * instance holding Date fields — and the MCP validator rejects a class instance as a record.
 * Serialising is the adapter's job: the domain shape and the wire shape are not the same thing,
 * and pretending they are is what makes a client reject a perfectly valid result.
 */
function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return { value };
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
