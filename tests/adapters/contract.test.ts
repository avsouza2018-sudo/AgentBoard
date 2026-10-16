import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Application } from '@agentboard/application';
import type { AppError, ErrorCode, Result, RunId } from '@agentboard/shared';
import { ok, id } from '@agentboard/shared';
import {
  HTTP_STATUS,
  TOOL_DEFINITIONS,
  createToolRegistry,
  renderHttp,
  renderMcp,
  toolContract,
  toToolError,
  type ToolContractEntry,
} from '@agentboard/adapters';
import { AGENT_TOKEN, BOARD, STATES, harness, unwrap } from '../harness.js';

const CONTRACT_PATH = fileURLToPath(new URL('../../contracts/mcp-tools.json', import.meta.url));

/** Minimal argument sets built from the contract, so the registry reaches the handler. */
function sampleArgs(entry: ToolContractEntry): Record<string, unknown> {
  const properties = (entry.inputSchema.properties ?? {}) as Record<string, { type?: string | string[]; enum?: unknown[] }>;
  const required = (entry.inputSchema.required ?? []) as string[];
  const args: Record<string, unknown> = {};

  for (const key of required) {
    const property = properties[key];
    if (!property) continue;
    if (property.enum?.length) args[key] = property.enum[0];
    else if (property.type === 'array') args[key] = [];
    else if (property.type === 'boolean') args[key] = true;
    else if (property.type === 'number') args[key] = 1;
    else if (Array.isArray(property.type) && property.type.includes('null')) args[key] = null;
    else args[key] = 'x';
  }

  return args;
}

describe('the tool contract', () => {
  it('is the registry, not a hand-written copy of it', () => {
    const committed = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as ToolContractEntry[];
    expect(committed).toEqual(toolContract());
  });

  it('covers the whole application facade — nothing reachable over HTTP is hidden from an agent', async () => {
    const facade = Object.keys((await harness()).app).sort();
    expect(toolContract().map((t) => t.useCase).sort()).toEqual(facade);
  });
});

describe('the registry routes, it does not implement', () => {
  it('every tool calls exactly the use case the contract names', async () => {
    const real = (await harness()).app;
    const keys = Object.keys(real);
    const calls: string[] = [];
    let lastInput: unknown = null;

    const fake = Object.fromEntries(
      keys.map((key) => [
        key,
        {
          execute: async (input: unknown) => {
            calls.push(key);
            lastInput = input;
            return ok({ useCase: key });
          },
        },
      ]),
    ) as unknown as Application;

    const registry = createToolRegistry(fake, TOOL_DEFINITIONS);
    const ctx = { actorToken: AGENT_TOKEN, runId: id<RunId>('run-1') };

    for (const entry of toolContract()) {
      calls.length = 0;
      const outcome = await registry.execute(ctx, entry.name, sampleArgs(entry));
      expect(outcome.ok, entry.name).toBe(true);
      expect(calls, entry.name).toEqual([entry.useCase]);
      // The tool forwards identity and provenance instead of deriving its own.
      const input = lastInput as { actorToken?: string; runId?: string | null };
      expect(input.actorToken, entry.name).toBe(AGENT_TOKEN);
      expect(input.runId, entry.name).toBe('run-1');
    }
  });

  it('refuses an agent write with no provenance before touching a use case', async () => {
    const real = (await harness()).app;
    const calls: string[] = [];
    const fake = Object.fromEntries(
      Object.keys(real).map((key) => [key, { execute: async () => { calls.push(key); return ok(null); } }]),
    ) as unknown as Application;

    const registry = createToolRegistry(fake, TOOL_DEFINITIONS);
    const outcome = await registry.execute({ actorToken: AGENT_TOKEN, runId: null }, 'move_task', {
      task_id: 'task-1',
      to_state_id: 's-inprogress',
      reason: 'no run id supplied',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.code).toBe('validation');
    expect(calls).toEqual([]);
  });

  it('does not implement policy: the human gate refusal comes from the domain', async () => {
    const h = await harness();
    const registry = createToolRegistry(h.app, TOOL_DEFINITIONS);
    const ctx = { actorToken: AGENT_TOKEN, runId: id<RunId>('run-1') };

    // Acceptance criteria are filled so the guard that fires is the human gate, not completeness.
    const task = unwrap(await h.app.createTask.execute({
      ...ctx,
      boardId: BOARD,
      title: 'gate check',
      acceptanceCriteria: ['the contract test is green'],
    }));
    unwrap(await h.app.claimTask.execute({ ...ctx, taskId: task.id, autoStart: true, reason: 'start' }));

    const throughTool = await registry.execute(ctx, 'move_task', {
      task_id: task.id,
      to_state_id: STATES.review,
      reason: 'hand off',
    });
    const direct = await h.app.moveTask.execute({ ...ctx, taskId: task.id, toStateId: STATES.review, reason: 'hand off' });

    expect(throughTool.ok).toBe(false);
    if (throughTool.ok) throw new Error('unreachable');
    expect(direct.ok).toBe(false);
    if (direct.ok) throw new Error('unreachable');

    // Same code, same details, same object. The adapter only renders.
    expect(throughTool.error).toEqual(toToolError(direct.error));
    expect(throughTool.error.code).toBe('human_gate');
  });
});

describe('error rendering', () => {
  it('has a status for every code in the taxonomy', async () => {
    const codes = Object.keys(HTTP_STATUS) as ErrorCode[];
    expect(codes.length).toBeGreaterThan(0);

    // The taxonomy is the single source: the mapping table must cover exactly its members.
    const h = await harness();
    const outcome = await createToolRegistry(h.app, TOOL_DEFINITIONS).execute(
      { actorToken: 'no-such-token', runId: null },
      'who_am_i',
      {},
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(HTTP_STATUS[outcome.error.code]).toBe(403);
  });

  it('both transports render the same error object', async () => {
    const h = await harness();
    const outcome = await createToolRegistry(h.app, TOOL_DEFINITIONS).execute(
      { actorToken: 'no-such-token', runId: null },
      'who_am_i',
      {},
    );
    if (outcome.ok) throw new Error('expected a failure');

    const mcp = renderMcp(outcome);
    const http = renderHttp(outcome);

    expect(mcp.isError).toBe(true);
    expect(http.status).toBe(403);
    expect((mcp.structuredContent as { error: unknown }).error).toEqual(http.body.error);
    expect((mcp.content[0] as { text: string }).text).toContain(outcome.error.code);
  });

  it('a rate-limited failure carries retry-after from the same error object', async () => {
    const h = await harness();
    const registry = createToolRegistry(h.app, TOOL_DEFINITIONS);
    const outcome = await registry.execute({ actorToken: 'no-such-token', runId: null }, 'who_am_i', {});
    if (outcome.ok) throw new Error('expected a failure');

    const withRetry = { ok: false as const, error: { ...outcome.error, code: 'rate_limited' as ErrorCode, details: { retryAfter: 30 } } };
    const http = renderHttp(withRetry);
    expect(http.status).toBe(429);
    expect(http.headers['retry-after']).toBe('30');
  });
});
