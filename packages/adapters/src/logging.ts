import type { ErrorCode } from '@agentboard/shared';

export type LogLevel = 'info' | 'warn';

/**
 * One record per tool call, assembled by the registry both transports share.
 *
 * The record names the actor, never the credential. A token is an input to the system and a secret;
 * echoing it into a log line would put the proof of identity in a place where it is copied, retained,
 * and read by people who were not the caller. The audit trail already answers "who moved this card"
 * with an actor id, so the operational log can say the same thing without carrying the thing that
 * proves it.
 *
 * `route` comes from the tool definition, not from the request. Every tool has exactly one route, so a
 * call over MCP and a call over REST log the same path — which is the same reason OpenAPI is generated
 * from the definitions rather than written beside them.
 */
export interface LogEntry {
  at: string;
  level: LogLevel;
  event: 'tool_call';
  transport: string;
  actorId: string | null;
  runId: string | null;
  tool: string;
  kind: 'read' | 'write' | null;
  route: string | null;
  outcome: 'ok' | 'refusal';
  /** The code from the same taxonomy the HTTP and MCP renderers use. Nothing is re-classified here. */
  code: ErrorCode | null;
  durationMs: number;
  /** True when the call was refused before any use case ran. */
  limited: boolean;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

/** Newline-delimited JSON: one call, one line, parseable by anything that reads a log. */
export function jsonLineSink(stream: { write(chunk: string): void }): LogSink {
  return { write: (entry) => stream.write(`${JSON.stringify(entry)}\n`) };
}

/** A sink a test can read. Same interface, so the code under test is the code that runs in production. */
export function collectSink(): LogSink & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    write: (entry) => {
      entries.push(entry);
    },
  };
}
