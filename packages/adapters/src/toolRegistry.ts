import { z } from 'zod';
import type { Application } from '@agentboard/application';
import type { Clock } from '@agentboard/domain';
import type { AppError, Result } from '@agentboard/shared';
import { err, RateLimitedError, ValidationError } from '@agentboard/shared';
import type { LogSink } from './logging.js';
import type { RateLimiter } from './rateLimit.js';
import type { ToolContext } from './toolContext.js';
import { outcomeOf, type ToolOutcome } from './toolOutcome.js';

export type ToolKind = 'read' | 'write';

/** MCP tool annotations. Hints, not guarantees — but they are hints we intend to be true. */
export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface RouteSpec {
  readonly method: 'GET' | 'POST';
  /**
   * Path template under `/api`. `{name}` placeholders name arguments of `inputSchema`, and the
   * route table refuses a placeholder the tool does not accept. A route is not documentation:
   * the HTTP router is built from these definitions, which is the only reason the REST surface
   * and the MCP surface cannot drift.
   */
  readonly path: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly annotations: ToolAnnotations;
  readonly route: RouteSpec;
  readonly inputSchema: z.ZodTypeAny;
  /**
   * Which use case this tool calls. This is not documentation: the contract test calls
   * `app[useCase]` directly and compares it with the tool's result, so a tool that stops
   * calling its use case fails the build.
   */
  readonly useCase: keyof Application;
  execute(app: Application, ctx: ToolContext, args: unknown): Promise<Result<unknown, AppError>>;
}

interface ToolMeta {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly annotations: ToolAnnotations;
  readonly route: RouteSpec;
  readonly useCase: keyof Application;
}

/**
 * The schema is a separate argument on purpose. Inferred through a single object literal,
 * `z.infer<S>` is deferred and `args` collapses to `unknown`; as its own argument, S is fixed
 * before the handler is checked, so every tool's arguments stay typed. The cast below is the
 * only one in this layer, and it is safe because the registry parses with `inputSchema` before
 * `handler` is ever reached.
 */
export function defineTool<S extends z.ZodTypeAny>(
  meta: ToolMeta,
  inputSchema: S,
  handler: (app: Application, ctx: ToolContext, args: z.infer<S>) => Promise<Result<unknown, AppError>>,
): ToolDefinition {
  return {
    ...meta,
    inputSchema,
    execute: (app, ctx, args) => handler(app, ctx, args as z.infer<S>),
  };
}

export interface ToolRegistry {
  readonly tools: readonly ToolDefinition[];
  find(name: string): ToolDefinition | undefined;
  /** Rate limit, parse, prove provenance, then call exactly one use case. */
  execute(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolOutcome>;
}

export interface RegistryOptions {
  /** Refused before any use case runs. A limit that runs the use case and then complains is not a limit. */
  readonly limiter?: RateLimiter;
  /** One entry per call, whatever the outcome. A log that only records successes cannot answer what went wrong. */
  readonly log?: LogSink;
  /** Injected so a test can read a timestamp without waiting for one. */
  readonly clock?: Clock;
}

/**
 * An agent write must say where it came from. A human acting through a browser has no run;
 * an agent always does, and the audit log is only worth reading if every agent write carries
 * its provenance. Enforced here, in the layer both transports share, so the rule cannot be
 * true for MCP and false for HTTP.
 */
function requireProvenance(tool: ToolDefinition, ctx: ToolContext): Result<unknown, AppError> {
  if (tool.kind === 'write' && ctx.runId === null) {
    return { ok: false, error: new ValidationError(`${tool.name} requires a run id`, { runId: null, tool: tool.name }) };
  }
  return { ok: true, value: undefined };
}

export function createToolRegistry(
  app: Application,
  tools: readonly ToolDefinition[],
  options: RegistryOptions = {},
): ToolRegistry {
  const clock = options.clock ?? { now: () => new Date() };
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  async function run(tool: ToolDefinition, ctx: ToolContext, rawArgs: unknown): Promise<ToolOutcome> {
    const decision = options.limiter?.check(ctx.actorToken);
    if (decision && !decision.allowed) {
      return outcomeOf(err(new RateLimitedError(decision.retryAfterSeconds)));
    }

    const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return outcomeOf({
        ok: false,
        error: new ValidationError(`invalid arguments for '${tool.name}'`, {
          tool: tool.name,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        }),
      });
    }

    const provenance = requireProvenance(tool, ctx);
    if (!provenance.ok) return outcomeOf(provenance);

    return outcomeOf(await tool.execute(app, ctx, parsed.data));
  }

  return {
    tools,
    find: (name) => byName.get(name),
    async execute(ctx, name, rawArgs): Promise<ToolOutcome> {
      const startedAt = clock.now();
      const tool = byName.get(name);

      const outcome = tool
        ? await run(tool, ctx, rawArgs)
        : outcomeOf(err(new ValidationError(`unknown tool '${name}'`, { tool: name, known: tools.map((t) => t.name) })));

      options.log?.write({
        at: clock.now().toISOString(),
        level: outcome.ok ? 'info' : 'warn',
        event: 'tool_call',
        transport: ctx.transport ?? 'unknown',
        actorId: ctx.actorId ?? null,
        runId: ctx.runId,
        tool: name,
        kind: tool?.kind ?? null,
        route: tool?.route?.path ?? null,
        outcome: outcome.ok ? 'ok' : 'refusal',
        code: outcome.ok ? null : outcome.error.code,
        durationMs: clock.now().getTime() - startedAt.getTime(),
        limited: !outcome.ok && outcome.error.code === 'rate_limited',
      });

      return outcome;
    },
  };
}
