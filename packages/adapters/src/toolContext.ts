import type { RunId } from '@agentboard/shared';

/**
 * What a transport knows about the caller before any tool runs: the bearer token that
 * identified them, and the run that produced the call.
 *
 * The transports build this (stdio from the environment, HTTP from the request headers);
 * the registry never reads a header or an env var itself. That is why the same registry
 * serves both — identity is an input, not a source.
 */
export interface ToolContext {
  readonly actorToken: string;
  readonly runId: RunId | null;
}

/** Minimal view of a request the transports hand to the registry. */
export interface RequestContext {
  readonly sessionId?: string | undefined;
}

export type ContextResolver = (request: RequestContext) => ToolContext | null;
