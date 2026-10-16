import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_TOKEN, BOARD, HUMAN, STATES } from '../harness.js';
import { FIELDS, OPERATIONS } from '../../apps/web/src/contract.js';
import { parseFrame, type Frame } from '../../apps/web/src/live.js';
import { connect } from '../../apps/web/src/live.js';
import { dataOf, session, unwrap } from './session.js';

const OPENAPI_PATH = fileURLToPath(new URL('../../contracts/openapi.json', import.meta.url));

interface Document {
  paths: Record<string, Record<string, { operationId: string }>>;
}

const document = () => JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Document;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

describe('the client against the contract it claims to consume', () => {
  it('calls only operations the generated contract describes', async () => {
    const doc = document();
    const checked: string[] = [];

    for (const [name, operation] of Object.entries(OPERATIONS)) {
      // The live feed is the one path the server serves outside the tool table, so it is checked
      // against a running server instead.
      if (name === 'events') continue;

      expect(
        doc.paths[operation.path]?.[operation.method.toLowerCase()],
        `${operation.method} ${operation.path} is not in the contract`,
      ).toBeTruthy();

      checked.push(`${operation.method} ${operation.path}`);
    }

    expect(checked.length).toBe(11);
  });

  it('the live feed path is the one the adapter actually serves', async () => {
    const s = await session();

    const response = await fetch(s.client.eventsUrl(BOARD), { headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    const reader = response.body!.getReader();
    const first = await reader.read();

    const frame = parseFrame((first.value ? new TextDecoder().decode(first.value) : '').trim());

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(frame?.event).toBe('connected');
    expect(frame?.data.boardId).toBe(BOARD);

    reader.cancel().catch(() => undefined);
    s.close();
  });

  it('reads the shapes the server actually sends', async () => {
    const s = await session();

    const created = dataOf(await s.client.createTask(BOARD, { board_id: BOARD, title: 'Shape check' }));

    // A write returns the aggregate, not the read DTO — the mirror has to be true for both.
    expect(Object.keys(created).sort()).toEqual([...FIELDS.taskAggregate].sort());

    const page = dataOf(await s.client.listTasks(BOARD));
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual([...FIELDS.taskSummary].sort());

    const activity = dataOf(await s.client.activity(BOARD));
    expect(Object.keys(activity[0] ?? {}).sort()).toEqual([...FIELDS.activity].sort());

    // The roster is a read model, so the mirror has to be true for it too — including the fact the
    // audit trail cannot answer, which is who minted the credential.
    const roster = dataOf(await s.client.agents(BOARD));
    expect(Object.keys(roster[0] ?? {}).sort()).toEqual([...FIELDS.agent].sort());
    expect(roster[0]?.registeredBy).toBe(HUMAN); // agents first, and atlas's credential was minted by ada
    expect(roster.find((a) => a.registeredBy === null)?.type).toBe('human'); // the seed row: the one registration nobody performed

    // A write returns the aggregate, whose lease carries no status; the read model's lease does. The
    // mirror lists both, and the live JSON is what proves the lists.
    dataOf(await s.client.claim(created.id));
    const leased = (dataOf(await s.client.listTasks(BOARD)).items.find((t) => t.id === created.id))?.lease;
    expect(Object.keys(leased ?? {}).sort()).toEqual([...FIELDS.lease].sort());

    const refusal = await s.client.move({ task_id: created.id, to_state_id: STATES.done, reason: 'no transition' });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error('expected a refusal');
    expect(Object.keys(refusal.error).sort()).toEqual([...FIELDS.error].sort());

    s.close();
  });

  it('does not re-classify a refusal — it hands over the body it was given', async () => {
    const s = await session();

    const task = unwrap(
      await s.h.app.createTask.execute({ actorToken: AGENT_TOKEN, runId: null, boardId: BOARD, title: 'Refused plainly' }),
    );

    const raw = await fetch(`http://127.0.0.1:${s.port}/api/tasks/${task.id}/move`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'content-type': 'application/json', 'x-run-id': 'run-page' },
      body: JSON.stringify({ task_id: task.id, to_state_id: STATES.review, reason: 'hand off' }),
    });
    const body = (await raw.json()) as { error?: Record<string, unknown> };

    const viaClient = await s.client.move({ task_id: task.id, to_state_id: STATES.review, reason: 'hand off' });

    expect(viaClient.ok).toBe(false);
    if (viaClient.ok) throw new Error('expected a refusal');
    expect(viaClient.error).toEqual(body.error);

    s.close();
  });

  it('carries the run id, and the run id lands in the audit trail', async () => {
    const s = await session();

    const task = unwrap(
      await s.h.app.createTask.execute({ actorToken: AGENT_TOKEN, runId: null, boardId: BOARD, title: 'Attributed work' }),
    );

    const moved = dataOf(await s.client.move({ task_id: task.id, to_state_id: STATES.inProgress, reason: 'started' }));
    const activity = dataOf(await s.client.activity(BOARD, { task_id: task.id }));

    expect(moved.version).toBe(task.version + 1);
    expect(activity.some((row) => row.type === 'TaskMoved' && row.runId === 'run-page')).toBe(true);

    s.close();
  });

  it('a real frame from the outbox moves the card on the page', async () => {
    const s = await session();

    const created = dataOf(await s.client.createTask(BOARD, { board_id: BOARD, title: 'Watched by the page' }));
    await s.store.load();

    const frames: Frame[] = [];
    const connection = await connect(s.client.eventsUrl(BOARD), AGENT_TOKEN, (frame) => {
      frames.push(frame);
      s.store.applyFrame(frame);
    });

    // Moved by the client, not by the store: what the page shows has to come from the feed, not from
    // its own call.
    dataOf(await s.client.move({ task_id: created.id, to_state_id: STATES.inProgress, reason: 'started' }));

    const arrived = await waitFor(() => s.store.view.feed.some((item) => item.event === 'TaskMoved'));

    expect(arrived).toBe(true);
    expect(s.store.view.connected).toBe(true);

    const card = s.store.view.columns.flatMap((column) => column.cards).find((c) => c.id === created.id);
    expect(card?.statusName).toBe('In Progress');
    expect(s.store.view.feed.some((item) => item.runId === 'run-page')).toBe(true);

    connection.close();
    s.close();
  });
});
