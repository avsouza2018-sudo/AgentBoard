import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { buildToolRegistry, createMcpServer, httpStatusFor, startMcpHttpServer, type ToolContext } from '@agentboard/adapters';
import type { ErrorCode } from '@agentboard/shared';
import { id, type RunId } from '@agentboard/shared';
import { AGENT_TOKEN, BOARD, HUMAN_TOKEN, STATES, harness } from '../harness.js';

/**
 * The same registry behind two transports. If the tool surface were transport-specific — a
 * schema built for stdio, a different error shape for HTTP — this is where it would show.
 */
async function httpSession() {
  const h = await harness();
  const registry = buildToolRegistry(h.app);

  const server = startMcpHttpServer(
    {
      registry,
      authenticate: (token) => (token ? { actorToken: token, runId: id<RunId>('run-http') } : null),
    },
    0,
  );
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  async function connect(token: string) {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    // Same `exactOptionalPropertyTypes` friction as the adapter: the SDK's Transport declares
    // sessionId as string, a stateless transport has none.
    await client.connect(transport as unknown as Transport);
    return client;
  }

  return { h, registry, server, port, connect };
}

async function inMemorySession(registry: ReturnType<typeof buildToolRegistry>, ctx: ToolContext) {
  const server = createMcpServer(registry, () => ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'in-memory-test', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('the HTTP transport', () => {
  it('serves the same tool list as the stdio-side protocol layer', async () => {
    const s = await httpSession();
    const overHttp = await (await s.connect(AGENT_TOKEN)).listTools();
    const overInMemory = await (await inMemorySession(s.registry, { actorToken: AGENT_TOKEN, runId: id<RunId>('run-http') })).client.listTools();

    expect(overHttp.tools).toEqual(overInMemory.tools);
    expect(overHttp.tools).toHaveLength(17);

    s.server.close();
  });

  it('binds identity per request, so a session cannot inherit another agent', async () => {
    const s = await httpSession();

    const agent = await (await s.connect(AGENT_TOKEN)).callTool({ name: 'who_am_i', arguments: {} });
    const human = await (await s.connect(HUMAN_TOKEN)).callTool({ name: 'who_am_i', arguments: {} });

    expect((agent.structuredContent as { actor: { id: string } }).actor.id).toBe('agent-atlas');
    expect((human.structuredContent as { actor: { id: string } }).actor.id).toBe('human-ada');

    s.server.close();
  });

  it('answers a missing token with the same error the application gives', async () => {
    const s = await httpSession();
    const client = await s.connect('');
    const refused = await client.callTool({ name: 'who_am_i', arguments: {} });

    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe('permission');

    s.server.close();
  });

  it('reports the same failure through both transports', async () => {
    const s = await httpSession();
    const client = await s.connect(AGENT_TOKEN);

    const created = await client.callTool({ name: 'create_task', arguments: { board_id: BOARD, title: 'parity', acceptance_criteria: ['the contract test is green'] } });
    const task = (created.structuredContent as { id: string }).id;

    await client.callTool({ name: 'claim_task', arguments: { task_id: task, auto_start: true, reason: 'start' } });

    const overHttp = await client.callTool({
      name: 'move_task',
      arguments: { task_id: task, to_state_id: STATES.review, reason: 'hand off' },
    });

    const mirror = await inMemorySession(s.registry, { actorToken: AGENT_TOKEN, runId: id<RunId>('run-http') });
    const overInMemory = await mirror.client.callTool({
      name: 'move_task',
      arguments: { task_id: task, to_state_id: STATES.review, reason: 'hand off' },
    });

    expect(overHttp.isError).toBe(true);
    expect((overHttp.structuredContent as { error: unknown }).error).toEqual(
      (overInMemory.structuredContent as { error: unknown }).error,
    );
    // The status the HTTP API will answer with for this code, from the same table.
    expect(httpStatusFor((overHttp.structuredContent as { error: { code: ErrorCode } }).error.code)).toBe(403);

    await mirror.client.close();
    await mirror.server.close();
    s.server.close();
  });

  it('answers GET with 405 because a stateless endpoint has no session to stream to', async () => {
    const s = await httpSession();
    const response = await fetch(`http://127.0.0.1:${s.port}/mcp`);
    expect(response.status).toBe(405);

    const health = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(health.status).toBe(200);

    s.server.close();
  });
});
