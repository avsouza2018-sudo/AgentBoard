import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  OutboxStream,
  buildToolRegistry,
  collectSink,
  createMcpServer,
  createTokenBucket,
  startApiServer,
  type ApiRequest,
  type LogEntry,
  type ToolContext,
} from '@agentboard/adapters';
import { FixedClock } from '@agentboard/infra';
import { id, type RunId } from '@agentboard/shared';
import { AGENT, AGENT_TOKEN, BOARD, harness } from '../harness.js';

const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));

async function loggingSession() {
  const h = await harness();
  const sink = collectSink();
  const registry = buildToolRegistry(h.app, { log: sink, clock });

  // The same shape the composition root builds: the transport resolves the token once at the boundary,
  // so the log can name the actor without carrying the credential.
  const resolve = async (request: ApiRequest): Promise<ToolContext | null> =>
    request.token === null
      ? null
      : { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null, actorId: (await h.deps.resolver.resolve(request.token))?.id ?? null };

  const stream = new OutboxStream(h.publisher, { intervalMs: 20 });
  const api = startApiServer({ app: h.app, registry, stream, resolve }, 0);
  const port = (api.server.address() as AddressInfo).port;

  return {
    h,
    sink,
    registry,
    port,
    ctx: { actorToken: AGENT_TOKEN, runId: id<RunId>('run-log'), actorId: AGENT, transport: 'http' } satisfies ToolContext,
    call: async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'x-run-id': 'run-log' },
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    close: () => api.close(),
  };
}

async function protocolSession(registry: ReturnType<typeof buildToolRegistry>, ctx: ToolContext, transport: string) {
  const server = createMcpServer(registry, () => ({ ...ctx, transport }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'log-parity', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('the operational log', () => {
  it('writes exactly one entry per call, whatever the outcome', async () => {
    const s = await loggingSession();

    await s.call('/api/me');
    await s.call('/api/boards/board-1/tasks?limit=1');
    await s.call('/api/boards/nope/tasks');

    expect(s.sink.entries).toHaveLength(3);
    expect(s.sink.entries.map((e) => e.tool)).toEqual(['who_am_i', 'list_tasks', 'list_tasks']);
    expect(s.sink.entries.map((e) => e.outcome)).toEqual(['ok', 'ok', 'refusal']);
    expect(s.sink.entries[2]?.code).toBe('not_found');
    expect(s.sink.entries[2]?.level).toBe('warn');

    s.close();
  });

  it('records the call the limiter refused, and says it was refused before anything ran', async () => {
    const h = await harness();
    const sink = collectSink();
    const registry = buildToolRegistry(h.app, { log: sink, limiter: createTokenBucket({ capacity: 1, refillPerSecond: 1, clock }), clock });
    const ctx = { actorToken: AGENT_TOKEN, runId: null, actorId: AGENT, transport: 'stdio' } satisfies ToolContext;

    await registry.execute(ctx, 'who_am_i', {});
    await registry.execute(ctx, 'who_am_i', {});

    expect(sink.entries).toHaveLength(2);
    expect(sink.entries[0]?.limited).toBe(false);
    expect(sink.entries[1]?.limited).toBe(true);
    expect(sink.entries[1]?.code).toBe('rate_limited');
    expect(sink.entries[1]?.outcome).toBe('refusal');

    // The audit trail records what a committed transaction wrote. A refused call never opened one, so
    // the operational log is the only place this call exists — which is why it must record refusals.
    expect(h.activity.all()).toHaveLength(0);
  });

  it('names the actor and never the credential', async () => {
    const s = await loggingSession();

    await s.call('/api/me');

    const line = JSON.stringify(s.sink.entries[0]);
    expect(s.sink.entries[0]?.actorId).toBe(AGENT);
    expect(line).not.toContain(AGENT_TOKEN);

    // The proof of identity has no business being in a log line: a log is copied, retained, and read
    // by people who were not the caller.
    const every = s.sink.entries.map((e) => JSON.stringify(e)).join('\n');
    expect(every).not.toContain(AGENT_TOKEN);
    expect(every).not.toContain('Bearer');

    s.close();
  });

  it('logs the same route for the same tool through both doors, and names the door it came through', async () => {
    const h = await harness();
    const sink = collectSink();
    const registry = buildToolRegistry(h.app, { log: sink, clock });
    const ctx = { actorToken: AGENT_TOKEN, runId: null, actorId: AGENT } satisfies ToolContext;

    const overPipe = await protocolSession(registry, ctx, 'stdio');
    await overPipe.client.callTool({ name: 'who_am_i', arguments: {} });

    const stream = new OutboxStream(h.publisher, { intervalMs: 20 });
    const api = startApiServer({
      app: h.app,
      registry,
      stream,
      resolve: async (request: ApiRequest) => (request.token === null
        ? null
        : { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null, actorId: (await h.deps.resolver.resolve(request.token))?.id ?? null }),
    }, 0);
    const port = (api.server.address() as AddressInfo).port;
    await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });

    const entries = sink.entries as LogEntry[];
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.transport)).toEqual(['stdio', 'http']);
    // The route comes from the tool definition, so both doors say the same path for the same tool.
    expect(new Set(entries.map((e) => e.route))).toEqual(new Set(['/api/me']));
    expect(new Set(entries.map((e) => e.actorId))).toEqual(new Set([AGENT]));

    await overPipe.client.close();
    await overPipe.server.close();
    api.close();
  });

  it('records the run that produced the call, so a write can be traced to the agent run that made it', async () => {
    const s = await loggingSession();

    await fetch(`http://127.0.0.1:${s.port}/api/boards/${BOARD}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'content-type': 'application/json', 'x-run-id': 'run-log' },
      body: JSON.stringify({ board_id: BOARD, title: 'Logged write' }),
    });

    const entry = s.sink.entries[0];
    expect(entry?.tool).toBe('create_task');
    expect(entry?.kind).toBe('write');
    expect(entry?.runId).toBe('run-log');
    expect(entry?.route).toBe('/api/boards/{board_id}/tasks');

    s.close();
  });

  it('refuses an agent write with no run, and logs the refusal it produced', async () => {
    const h = await harness();
    const sink = collectSink();
    const registry = buildToolRegistry(h.app, { log: sink, clock });

    await registry.execute({ actorToken: AGENT_TOKEN, runId: null, actorId: AGENT, transport: 'stdio' }, 'create_task', {
      board_id: BOARD,
      title: 'no provenance',
    });

    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.outcome).toBe('refusal');
    expect(sink.entries[0]?.code).toBe('validation');
    expect(h.activity.all()).toHaveLength(0);
  });
});
