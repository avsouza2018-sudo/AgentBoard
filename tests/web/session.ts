import type { AddressInfo } from 'node:net';
import { OutboxStream, buildToolRegistry, startApiServer, type ApiRequest, type ToolContext } from '@agentboard/adapters';
import { id, type RunId } from '@agentboard/shared';
import { ApiClient } from '../../apps/web/src/api.js';
import { BoardStore } from '../../apps/web/src/store.js';
import { AGENT_TOKEN, BOARD, harness } from '../harness.js';

/**
 * A page against a live server. The client is the real one — the test is only meaningful if the
 * shapes it reads are the shapes the server sends, so nothing here is stubbed except the moment a
 * response is released.
 */
export async function session(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const h = await harness();
  const registry = buildToolRegistry(h.app);
  const stream = new OutboxStream(h.publisher, { intervalMs: 20 });

  const resolve = (request: ApiRequest): ToolContext | null =>
    request.token ? { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null } : null;

  const api = startApiServer({ app: h.app, registry, stream, resolve }, 0);
  const port = (api.server.address() as AddressInfo).port;

  const client = new ApiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: AGENT_TOKEN,
    runId: 'run-page',
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });

  return {
    h,
    api,
    stream,
    client,
    store: new BoardStore(client, BOARD),
    port,
    close(): void {
      api.close();
    },
  };
}

/**
 * A fetch that holds a write until it is released. Without it, an optimistic move resolves before
 * the test can look at the card, and the whole point of an optimistic move is the moment in between.
 *
 * Reads are not held: the store re-reads the board when a refusal arrives, and a gate that held
 * every request would hold that re-read too — the test would measure the gate, not the rollback.
 */
export function gate() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    release,
    fetchImpl: async (url: string, init?: RequestInit): Promise<Response> => {
      const response = await fetch(url, init);
      if (init?.method === 'POST') await held;
      return response;
    },
  };
}

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.message}`);
  return r.value;
}

/** A client outcome, not a domain Result: the client's success carries `data`, not `value`. */
export function dataOf<T>(outcome: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!outcome.ok) throw new Error(`expected ok, got ${outcome.error.code}: ${outcome.error.message}`);
  return outcome.data;
}
