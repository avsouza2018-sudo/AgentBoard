import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { OutboxStream, buildToolRegistry, startApiServer, type ApiRequest, type ToolContext } from '@agentboard/adapters';
import { id, type RunId } from '@agentboard/shared';
import { AGENT_TOKEN, BOARD, harness, unwrap } from '../harness.js';

interface Frame {
  id: string;
  event: string;
  data: string;
}

type Chunk = { done: boolean; value?: Uint8Array | undefined };

class FrameReader {
  private buffer = '';
  private pending: Promise<Chunk> | null = null;
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(timeoutMs = 2000): Promise<Frame | null> {
    while (!this.buffer.includes('\n\n')) {
      const read = this.pending ?? (this.reader.read() as Promise<Chunk>);
      this.pending = read;

      const raced = await Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
      // A timed-out read stays pending on the stream, so the next call picks up the same chunk
      // instead of losing the frame it eventually returns.
      if (raced === null) return null;

      this.pending = null;
      if (raced.done) throw new Error('stream closed before a frame arrived');
      this.buffer += this.decoder.decode(raced.value ?? new Uint8Array(), { stream: true });
    }

    const end = this.buffer.indexOf('\n\n');
    const frame = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end + 2);

    const fields = new Map<string, string>();
    for (const line of frame.split('\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }

    return { id: fields.get('id') ?? '', event: fields.get('event') ?? '', data: fields.get('data') ?? '' };
  }
}

async function sseSession() {
  const h = await harness();
  const registry = buildToolRegistry(h.app);

  // A long interval keeps the test deterministic: the only dispatch is the one the test triggers.
  const stream = new OutboxStream(h.publisher, { intervalMs: 10_000 });
  const resolve = (request: ApiRequest): ToolContext | null =>
    request.token ? { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null } : null;

  const api = startApiServer({ app: h.app, registry, stream, resolve }, 0);
  const port = (api.server.address() as AddressInfo).port;

  const connect = async (token: string, boardId: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/boards/${boardId}/events`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: res.body ? new FrameReader(res.body.getReader()) : null, port };
  };

  return { h, api, stream, port, connect };
}

describe('the live stream', () => {
  it('is fed by the outbox, so nothing is delivered before the post-commit dispatch', async () => {
    const s = await sseSession();
    const ctx = { actorToken: AGENT_TOKEN, runId: id<RunId>('run-sse') };

    const conn = await s.connect(AGENT_TOKEN, BOARD);
    expect(conn.status).toBe(200);
    expect((await conn.body?.next())?.event).toBe('connected');

    // A write through the use case appends to the outbox inside the transaction. The stream has
    // not dispatched, so it has nothing to say — which is exactly the promise: a frame is a row a
    // committed transaction wrote, not an event the code hoped would survive.
    unwrap(await s.h.app.createTask.execute({ ...ctx, boardId: BOARD, title: 'streamed', acceptanceCriteria: ['the frame arrives'] }));
    expect(await conn.body?.next(120)).toBeNull();

    expect(await s.stream.dispatch()).toBe(1);

    const frame = await conn.body?.next();
    expect(frame?.event).toBe('TaskCreated');
    const payload = JSON.parse(frame?.data ?? '{}') as { type: string; boardId: string; runId: string | null };
    expect(payload.type).toBe('TaskCreated');
    expect(payload.boardId).toBe(BOARD);
    // The frame carries the run that produced it — the same provenance the audit log records.
    expect(payload.runId).toBe('run-sse');
    expect(frame?.id).not.toBe('');

    s.api.close();
  });

  it('delivers a write that came through a REST route', async () => {
    const s = await sseSession();

    const conn = await s.connect(AGENT_TOKEN, BOARD);
    await conn.body?.next();

    const res = await fetch(`http://127.0.0.1:${s.port}/api/boards/${BOARD}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'x-run-id': 'run-sse', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'through the route', acceptance_criteria: ['the frame arrives'] }),
    });
    expect(res.status).toBe(200);

    const frame = await conn.body?.next();
    expect(frame?.event).toBe('TaskCreated');
    expect(JSON.parse(frame?.data ?? '{}')).toMatchObject({ runId: 'run-sse' });

    s.api.close();
  });

  it('fans out by board, so a subscriber cannot see another board\'s activity', async () => {
    const h = await harness();
    const stream = new OutboxStream(h.publisher, { intervalMs: 10_000 });

    const mine: string[] = [];
    const theirs: string[] = [];
    stream.subscribe(BOARD, (frame) => mine.push(frame));
    stream.subscribe(id('board-2'), (frame) => theirs.push(frame));

    await h.app.createTask.execute({
      actorToken: AGENT_TOKEN,
      runId: id<RunId>('run-sse'),
      boardId: BOARD,
      title: 'on my board',
      acceptanceCriteria: ['the frame arrives'],
    });

    expect(await stream.dispatch()).toBe(1);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toContain('event: TaskCreated');
    expect(theirs).toHaveLength(0);
    // A row is drained once: a second dispatch cannot deliver it twice.
    expect(await stream.dispatch()).toBe(0);
    expect(mine).toHaveLength(1);
  });

  it('authorises through the facade, not through a header alone', async () => {
    const s = await sseSession();

    const noToken = await fetch(`http://127.0.0.1:${s.port}/api/boards/${BOARD}/events`);
    expect(noToken.status).toBe(403);

    const unknownBoard = await fetch(`http://127.0.0.1:${s.port}/api/boards/board-9/events`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(unknownBoard.status).toBe(403);
    const body = (await unknownBoard.json()) as { error: { code: string; details: { boardId: string } } };
    expect(body.error.code).toBe('permission');
    expect(body.error.details.boardId).toBe('board-9');

    const allowed = await fetch(`http://127.0.0.1:${s.port}/api/boards/${BOARD}/events`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(allowed.status).toBe(200);

    s.api.close();
  });
});
