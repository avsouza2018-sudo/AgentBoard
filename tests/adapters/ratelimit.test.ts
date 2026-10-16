import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Application } from '@agentboard/application';
import {
  OutboxStream,
  buildToolRegistry,
  createMcpServer,
  createTokenBucket,
  startApiServer,
  type ApiRequest,
  type RateLimiter,
  type ToolContext,
  type ToolRegistry,
} from '@agentboard/adapters';
import { FixedClock } from '@agentboard/infra';
import { id, ok, type RunId } from '@agentboard/shared';
import { AGENT_TOKEN, HUMAN_TOKEN, harness } from '../harness.js';

/**
 * A facade that records instead of executing. These tests are not about a limit producing a message;
 * they are about the message arriving *instead of* the work. A limiter that runs the use case and then
 * complains is a meter, not a limit.
 */
function recordingApp(real: Application) {
  const calls: string[] = [];
  const fake = Object.fromEntries(
    Object.keys(real).map((key) => [key, { execute: async () => { calls.push(key); return ok(null); } }]),
  ) as unknown as Application;
  return { fake, calls };
}

function resolver(h: Awaited<ReturnType<typeof harness>>) {
  return (request: ApiRequest): ToolContext | null =>
    request.token ? { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null } : null;
}

async function httpSession(app: Application, limiter: RateLimiter, clock: FixedClock) {
  const h = await harness();
  const registry = buildToolRegistry(app, { limiter, clock });
  const stream = new OutboxStream(h.publisher, { intervalMs: 20 });
  const api = startApiServer({ app, registry, stream, resolve: resolver(h) }, 0);
  const port = (api.server.address() as AddressInfo).port;

  return {
    h,
    close: () => api.close(),
    call: async (token: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
    },
  };
}

async function mcpSession(registry: ToolRegistry, ctx: ToolContext) {
  const server = createMcpServer(registry, () => ctx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'rate-parity', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, server };
}

describe('the rate limit', () => {
  it('refuses the call that spends the budget, before the use case runs', async () => {
    const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
    const h = await harness();
    const { fake, calls } = recordingApp(h.app);
    const limiter = createTokenBucket({ capacity: 2, refillPerSecond: 1, clock });
    const registry = buildToolRegistry(fake, { limiter, clock });
    const ctx = { actorToken: AGENT_TOKEN, runId: null };

    await registry.execute(ctx, 'who_am_i', {});
    await registry.execute(ctx, 'who_am_i', {});

    const refused = await registry.execute(ctx, 'who_am_i', {});
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.error.code).toBe('rate_limited');
    expect(refused.error.retryable).toBe(true);

    // Two calls reached the facade. The third produced the refusal without reaching it.
    expect(calls).toEqual(['whoAmI', 'whoAmI']);
  });

  it('answers over HTTP with 429 and a retry-after, from the same table MCP uses', async () => {
    const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
    const h = await harness();
    const s = await httpSession(h.app, createTokenBucket({ capacity: 2, refillPerSecond: 1, clock }), clock);

    await s.call(AGENT_TOKEN);
    await s.call(AGENT_TOKEN);

    const refused = await s.call(AGENT_TOKEN);
    expect(refused.status).toBe(429);
    expect((refused.body.error as Record<string, unknown>).code).toBe('rate_limited');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    s.close();
  });

  it('says the same thing over the protocol as it does over a route', async () => {
    const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
    const h = await harness();
    const limiter = createTokenBucket({ capacity: 1, refillPerSecond: 1, clock });
    const ctx = { actorToken: AGENT_TOKEN, runId: null };

    const overProtocol = await mcpSession(buildToolRegistry(h.app, { limiter, clock }), ctx);
    const first = await overProtocol.client.callTool({ name: 'who_am_i', arguments: {} });
    expect(first.isError).toBeFalsy();

    const second = await overProtocol.client.callTool({ name: 'who_am_i', arguments: {} });
    expect(second.isError).toBe(true);
    const overHttp = await httpSession(h.app, limiter, clock);
    const refused = await overHttp.call(AGENT_TOKEN);

    // Same code, same message, same `retryable`: the limiter lives in the shared registry, so the two
    // doors cannot disagree about the same exhausted bucket.
    const mcpError = (second.structuredContent as { error: { code: string; message: string; retryable: boolean } }).error;
    const httpError = refused.body.error as { code: string; message: string; retryable: boolean };
    expect(mcpError).toEqual(httpError);

    await overProtocol.client.close();
    await overProtocol.server.close();
    overHttp.close();
  });

  it('refills, and the refusal says when the caller may come back', async () => {
    const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
    const limiter = createTokenBucket({ capacity: 1, refillPerSecond: 2, clock });

    expect(limiter.check(AGENT_TOKEN).allowed).toBe(true);

    const refused = limiter.check(AGENT_TOKEN);
    expect(refused.allowed).toBe(false);
    if (refused.allowed) throw new Error('expected a refusal');
    expect(refused.retryAfterSeconds).toBe(1);

    clock.advance(1000);
    expect(limiter.check(AGENT_TOKEN).allowed).toBe(true);
  });

  it('is keyed by credential, not by actor', async () => {
    const clock = new FixedClock(new Date('2026-10-15T12:00:00.000Z'));
    const limiter = createTokenBucket({ capacity: 1, refillPerSecond: 1, clock });

    // Two tokens for the same actor are two clients. Merging them would let one runaway process spend
    // the other's budget, which is the failure a per-token limit exists to prevent.
    expect(limiter.check(AGENT_TOKEN).allowed).toBe(true);
    expect(limiter.check(AGENT_TOKEN).allowed).toBe(false);
    expect(limiter.check(HUMAN_TOKEN).allowed).toBe(true);
  });
});
