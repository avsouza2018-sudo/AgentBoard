import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildToolRegistry,
  buildRouteTable,
  createMcpServer,
  httpStatusFor,
  OutboxStream,
  startApiServer,
  toolContract,
  toToolError,
  type ApiRequest,
  type ToolContext,
  type ToolRegistry,
} from '@agentboard/adapters';
import { TOOL_DEFINITIONS } from '@agentboard/adapters';
import { id, type RunId } from '@agentboard/shared';
import { AGENT_TOKEN, BOARD, STATES, harness, unwrap } from '../harness.js';

type Body = Record<string, unknown>;
const dataOf = (body: Body): Body => body.data as Body;
const errorOf = (body: Body): Body => body.error as Body;

async function apiSession() {
  const h = await harness();
  const registry = buildToolRegistry(h.app);
  const stream = new OutboxStream(h.publisher, { intervalMs: 20 });

  const resolve = (request: ApiRequest): ToolContext | null =>
    request.token ? { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null } : null;

  const api = startApiServer({ app: h.app, registry, stream, resolve }, 0);
  const port = (api.server.address() as AddressInfo).port;

  const call = async (
    method: string,
    path: string,
    opts: { token?: string; runId?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: Body; headers: Headers }> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(opts.token !== undefined ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.runId !== undefined ? { 'x-run-id': opts.runId } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Body, headers: res.headers };
  };

  return { h, api, registry, stream, call };
}

/** The same registry, reached through the protocol instead of a route. */
async function mcpMirror(registry: ToolRegistry, ctx: ToolContext) {
  const server = createMcpServer(registry, () => ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'rest-parity', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('the route table', () => {
  it('is generated from the tool definitions, not written beside them', () => {
    const routes = buildRouteTable(TOOL_DEFINITIONS);
    const contract = toolContract();
    expect(routes).toHaveLength(contract.length);

    for (const entry of routes) {
      // A read tool has to be readable by a GET; a write tool must not be one.
      expect(entry.route.method, entry.tool.name).toBe(entry.tool.kind === 'read' ? 'GET' : 'POST');

      const properties = (contract.find((c) => c.name === entry.tool.name)!.inputSchema.properties ?? {}) as Record<string, unknown>;
      for (const arg of entry.pathArgs) {
        expect(properties, `${entry.route.path} reads {${arg}}, which ${entry.tool.name} does not accept}`).toHaveProperty(arg);
      }
    }
  });

  it('refuses a route that reads an argument its tool does not accept', () => {
    const broken = {
      ...TOOL_DEFINITIONS[0]!,
      route: { method: 'GET' as const, path: '/api/boards/{board_id}/tasks' },
      inputSchema: z.object({ title: z.string() }),
    };
    expect(() => buildRouteTable([broken])).toThrow(/does not accept/);
  });
});

describe('the REST surface', () => {
  it('the same tool call over a route and over the protocol produces the same result', async () => {
    const s = await apiSession();

    const created = await s.call('POST', '/api/boards/board-1/tasks', {
      token: AGENT_TOKEN,
      runId: 'run-rest',
      body: { title: 'parity', acceptance_criteria: ['the contract test is green'] },
    });
    expect(created.status).toBe(200);

    const overRest = await s.call('GET', '/api/boards/board-1/tasks?limit=1', { token: AGENT_TOKEN });
    const mirror = await mcpMirror(s.registry, { actorToken: AGENT_TOKEN, runId: id<RunId>('run-rest') });
    const overProtocol = await mirror.client.callTool({ name: 'list_tasks', arguments: { board_id: BOARD, limit: 1 } });

    expect(dataOf(overRest.body)).toEqual(overProtocol.structuredContent);

    await mirror.client.close();
    await mirror.server.close();
    s.api.close();
  });

  it('answers the same failure with the status the same table gives that code', async () => {
    const s = await apiSession();
    const ctx = { actorToken: AGENT_TOKEN, runId: id<RunId>('run-rest') };

    const task = unwrap(await s.h.app.createTask.execute({ ...ctx, boardId: BOARD, title: 'gate', acceptanceCriteria: ['the contract test is green'] }));
    unwrap(await s.h.app.claimTask.execute({ ...ctx, taskId: task.id, autoStart: true, reason: 'start' }));

    const overRest = await s.call('POST', `/api/tasks/${task.id}/move`, {
      token: AGENT_TOKEN,
      runId: 'run-rest',
      body: { to_state_id: STATES.review, reason: 'hand off' },
    });

    const direct = await s.h.app.moveTask.execute({ ...ctx, taskId: task.id, toStateId: STATES.review, reason: 'hand off' });
    if (direct.ok) throw new Error('expected the human gate to refuse');

    expect(overRest.status).toBe(httpStatusFor('human_gate'));
    // Same code, same details: the router renders, it does not reclassify.
    expect(errorOf(overRest.body)).toEqual(toToolError(direct.error));
    expect(errorOf(overRest.body).code).toBe('human_gate');

    s.api.close();
  });

  it('enforces provenance over HTTP exactly as it does over the protocol', async () => {
    const s = await apiSession();

    const noRun = await s.call('POST', '/api/boards/board-1/tasks', {
      token: AGENT_TOKEN,
      body: { title: 'no provenance', acceptance_criteria: ['the contract test is green'] },
    });
    expect(noRun.status).toBe(400);
    expect(errorOf(noRun.body).code).toBe('validation');

    const withRun = await s.call('POST', '/api/boards/board-1/tasks', {
      token: AGENT_TOKEN,
      runId: 'run-rest',
      body: { title: 'with provenance', acceptance_criteria: ['the contract test is green'] },
    });
    expect(withRun.status).toBe(200);

    s.api.close();
  });

  it('resolves identity through the same resolver the tools use', async () => {
    const s = await apiSession();

    const refused = await s.call('GET', '/api/me', { token: 'no-such-token' });
    const direct = await s.h.app.whoAmI.execute({ actorToken: 'no-such-token', runId: null });
    if (direct.ok) throw new Error('expected the resolver to refuse');

    expect(refused.status).toBe(403);
    expect(errorOf(refused.body)).toEqual(toToolError(direct.error));

    const human = await s.call('GET', '/api/me', { token: 'tok-human-ada' });
    expect((dataOf(human.body) as { actor: { id: string } }).actor.id).toBe('human-ada');

    s.api.close();
  });

  it('distinguishes a path served under another method from a path that is not in the table', async () => {
    const s = await apiSession();

    const wrongMethod = await s.call('GET', '/api/tasks/task-1/move', { token: AGENT_TOKEN, runId: 'run-rest' });
    expect(wrongMethod.status).toBe(405);
    expect(errorOf(wrongMethod.body).code).toBe('method_not_allowed');

    const unknown = await s.call('GET', '/api/nope', { token: AGENT_TOKEN, runId: 'run-rest' });
    expect(unknown.status).toBe(404);
    expect(errorOf(unknown.body).code).toBe('not_found');

    s.api.close();
  });

  it('treats the path as authoritative when a body disagrees with it', async () => {
    const s = await apiSession();
    const ctx = { actorToken: AGENT_TOKEN, runId: id<RunId>('run-rest') };

    const task = unwrap(await s.h.app.createTask.execute({ ...ctx, boardId: BOARD, title: 'which task?', acceptanceCriteria: ['the contract test is green'] }));

    const moved = await s.call('POST', `/api/tasks/${task.id}/move`, {
      token: AGENT_TOKEN,
      runId: 'run-rest',
      body: { task_id: 'a-different-task', to_state_id: STATES.inProgress, reason: 'start' },
    });

    expect(moved.status).toBe(200);
    expect((dataOf(moved.body) as { id: string }).id).toBe(task.id);

    s.api.close();
  });

  it('coerces query arguments with the schema that validates them, and lets the schema reject what it cannot', async () => {
    const s = await apiSession();

    await s.call('POST', '/api/boards/board-1/tasks', {
      token: AGENT_TOKEN,
      runId: 'run-rest',
      body: { title: 'one', acceptance_criteria: ['the contract test is green'] },
    });

    const page = await s.call('GET', '/api/boards/board-1/tasks?limit=1&only_blocked=true', { token: AGENT_TOKEN });
    expect(page.status).toBe(200);

    const bad = await s.call('GET', '/api/boards/board-1/tasks?limit=0', { token: AGENT_TOKEN });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(errorOf(bad.body).details)).toContain('limit');

    s.api.close();
  });
});
