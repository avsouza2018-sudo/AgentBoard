import { err, MethodNotAllowedError, NotFoundError, PermissionError, ValidationError } from '@agentboard/shared';
import { renderHttp, type HttpResponse } from '../errorMapping.js';
import { outcomeOf } from '../toolOutcome.js';
import type { ToolContext } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { argsFromRequest, coerceQuery, matchRoute, type MatchedRoute, type RouteEntry } from './routes.js';

/**
 * A request as the router sees it: already parsed, no socket. Keeping the router free of
 * `node:http` is what lets the same handler be tested against a plain object, and what lets a
 * server framework sit in front of it without changing a rule.
 */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  readonly token: string | null;
  /** Provenance. On stdio it comes from the environment; here, from `x-run-id`. */
  readonly runId: string | null;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

export interface ApiDeps {
  readonly registry: ToolRegistry;
  readonly routes: readonly RouteEntry[];
  /** Turns a token into an identity. Same `ActorResolver` behind it as every tool. */
  readonly resolve: (request: ApiRequest) => ToolContext | null;
}

/**
 * One route, one tool, one use case. The router does not parse into DTOs, does not validate, and
 * does not classify errors — it finds the tool the path names, hands the arguments to the
 * registry, and renders whatever comes back through the same table MCP uses.
 */
export async function handleApiRequest(request: ApiRequest, deps: ApiDeps): Promise<HttpResponse> {
  // Identity first: an unauthenticated caller is not told which routes exist.
  const ctx = deps.resolve(request);
  if (!ctx) {
    return renderHttp(outcomeOf(err(new PermissionError('a bearer token is required', { path: request.path }))));
  }

  const match = matchRoute(deps.routes, request.method, request.path);
  if (!match) {
    // A path that exists under a different method is 405; a path that is not in the table is 404.
    // Both come from the same taxonomy, so the router does not invent its own error shape.
    const served = matchRoute(deps.routes, null, request.path);
    const error = served
      ? new MethodNotAllowedError(request.path, served.entry.route.method)
      : new NotFoundError('route', `${request.method} ${request.path}`);
    return renderHttp(outcomeOf(err(error)));
  }

  const source = argumentsSource(match, request);
  if (source === null) {
    return renderHttp(
      outcomeOf(err(new ValidationError('a POST body must be a JSON object', { path: request.path }))),
    );
  }

  return renderHttp(await deps.registry.execute(ctx, match.entry.tool.name, argsFromRequest(match, source)));
}

function argumentsSource(match: MatchedRoute, request: ApiRequest): Record<string, unknown> | null {
  if (match.entry.route.method === 'GET') return coerceQuery(match, request.query);

  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) return null;
  return request.body as Record<string, unknown>;
}
