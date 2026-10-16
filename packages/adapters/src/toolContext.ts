import type { ActorId, RunId } from '@agentboard/shared';

/**
 * The credential-to-actor question, answered once at the boundary so a log line can name the caller
 * without carrying the thing that proves who they are. It is the same `ActorResolver` port the use
 * cases authorise through; here it is asked for a name, not for a permission.
 */
export type ActorLookup = (token: string) => Promise<ActorId | null>;

/**
 * What a transport knows about the caller before any tool runs: the bearer token that
 * identified them, the run that produced the call, and the identity the token resolved to.
 *
 * The transports build this (stdio from the environment, HTTP from the request headers);
 * the registry never reads a header or an env var itself. That is why the same registry
 * serves both — identity is an input, not a source.
 *
 * `actorId` exists for one reason: the log has to name the actor, and it must not print the
 * credential that proves who the actor is. A token is an input to the system; echoing it into a
 * log line would put a secret somewhere it is copied, retained, and read by people who were not
 * the caller. So the transport resolves once at the boundary and carries the id, while the use case
 * keeps resolving for its own authorisation — the same port answers both, and neither invents an identity.
 */
export interface ToolContext {
  readonly actorToken: string;
  readonly runId: RunId | null;
  readonly actorId?: ActorId | null;
  /** Which door the call came through. A log field, not a policy input: nothing here branches on it. */
  readonly transport?: string;
}

/** Minimal view of a request the transports hand to the registry. */
export interface RequestContext {
  readonly sessionId?: string | undefined;
}

/**
 * Identity resolution may be synchronous — a stdio process has one identity for the life of the
 * connection — or asynchronous, because an HTTP request has to look the token up. The adapter awaits
 * either, so one registry serves both doors and neither transport knows which one it is behind.
 */
export type ContextResolver = (request: RequestContext) => ToolContext | null | Promise<ToolContext | null>;

/**
 * The door names itself. The protocol half is shared by stdio and MCP-over-HTTP, so it cannot know
 * which door it is behind; the transport can, and it is the only place that should say. A log line
 * that does not name its door cannot tell an agent's runaway loop from a browser's reload.
 */
export function withTransport(ctx: ToolContext | null, transport: string): ToolContext | null {
  return ctx === null ? null : { ...ctx, transport };
}
