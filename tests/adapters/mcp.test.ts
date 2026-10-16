import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildToolRegistry, createMcpServer } from '@agentboard/adapters';
import type { ToolOutcome } from '@agentboard/adapters';
import { id, type RunId } from '@agentboard/shared';
import { AGENT_TOKEN, BOARD, STATES, harness, unwrap } from '../harness.js';

/**
 * A real MCP conversation over an in-memory transport: the same registry, the same protocol
 * handlers, no transport-specific code. Whatever this asserts is what a client sees.
 */
async function session(ctx: { actorToken: string; runId: RunId | null }) {
  const h = await harness();
  const registry = buildToolRegistry(h.app);
  const server = createMcpServer(registry, () => ctx);

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  const client = new Client({ name: 'contract-test', version: '1.0.0' });
  await client.connect(clientSide);

  return { h, client, server, registry, ctx };
}

function errorOf(outcome: ToolOutcome) {
  if (outcome.ok) throw new Error('expected an error outcome');
  return outcome.error;
}

describe('the MCP surface', () => {
  it('lists every tool with its schema and annotations', async () => {
    const s = await session({ actorToken: AGENT_TOKEN, runId: null });
    const listed = await s.client.listTools();

    expect(listed.tools).toHaveLength(17);
    for (const tool of listed.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBeTypeOf('boolean');
      expect(tool.annotations?.destructiveHint).toBeTypeOf('boolean');
      expect(tool.annotations?.idempotentHint).toBeTypeOf('boolean');
    }

    const read = listed.tools.filter((t) => t.annotations?.readOnlyHint);
    expect(read.length).toBe(6);

    await s.client.close();
    await s.server.close();
  });

  it('answers who_am_i with the actor behind the token', async () => {
    const s = await session({ actorToken: AGENT_TOKEN, runId: null });
    const result = await s.client.callTool({ name: 'who_am_i', arguments: {} });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { actor: { id: string; type: string } };
    expect(structured.actor.id).toBe('agent-atlas');
    expect(structured.actor.type).toBe('agent');

    await s.client.close();
    await s.server.close();
  });

  it('produces the same result as calling the use case directly', async () => {
    const viaTool = await session({ actorToken: AGENT_TOKEN, runId: id<RunId>('run-7') });
    const viaFacade = await session({ actorToken: AGENT_TOKEN, runId: id<RunId>('run-7') });

    const created = await viaTool.client.callTool({
      name: 'create_task',
      arguments: { board_id: BOARD, title: 'Ship the MCP surface', acceptance_criteria: ['contract test is green'] },
    });
    const task = (created.structuredContent as { id: string }).id;

    const moved = await viaTool.client.callTool({
      name: 'move_task',
      arguments: { task_id: task, to_state_id: STATES.inProgress, reason: 'started work' },
    });

    const direct = unwrap(await viaFacade.h.app.createTask.execute({
      actorToken: AGENT_TOKEN,
      runId: id<RunId>('run-7'),
      boardId: BOARD,
      title: 'Ship the MCP surface',
      acceptanceCriteria: ['contract test is green'],
    }));
    const directMoved = unwrap(await viaFacade.h.app.moveTask.execute({
      actorToken: AGENT_TOKEN,
      runId: id<RunId>('run-7'),
      taskId: direct.id,
      toStateId: STATES.inProgress,
      reason: 'started work',
    }));

    expect(moved.structuredContent).toEqual(JSON.parse(JSON.stringify(directMoved)));

    await viaTool.client.close();
    await viaTool.server.close();
    await viaFacade.client.close();
    await viaFacade.server.close();
  });

  it('refuses the human gate through the tool, for the reason the domain gives', async () => {
    const s = await session({ actorToken: AGENT_TOKEN, runId: id<RunId>('run-8') });

    const created = await s.client.callTool({ name: 'create_task', arguments: { board_id: BOARD, title: 'gate', acceptance_criteria: ['the contract test is green'] } });
    const task = (created.structuredContent as { id: string }).id;

    await s.client.callTool({ name: 'claim_task', arguments: { task_id: task, auto_start: true, reason: 'start' } });

    const refused = await s.client.callTool({ name: 'move_task', arguments: { task_id: task, to_state_id: STATES.review, reason: 'hand off' } });

    expect(refused.isError).toBe(true);
    expect(errorOf(await s.registry.execute(s.ctx, 'move_task', { task_id: task, to_state_id: STATES.review, reason: 'hand off' })).code).toBe('human_gate');

    await s.client.close();
    await s.server.close();
  });

  it('refuses an agent write with no run id, before any use case runs', async () => {
    const s = await session({ actorToken: AGENT_TOKEN, runId: null });
    const refused = await s.client.callTool({ name: 'create_task', arguments: { board_id: BOARD, title: 'no provenance' } });

    expect(refused.isError).toBe(true);
    const error = (refused.structuredContent as { error: { code: string } }).error;
    expect(error.code).toBe('validation');

    await s.client.close();
    await s.server.close();
  });

  it('rejects arguments that do not match the published schema', async () => {
    const s = await session({ actorToken: AGENT_TOKEN, runId: id<RunId>('run-9') });
    const refused = await s.client.callTool({ name: 'move_task', arguments: { task_id: 'task-1', to_state_id: 's-done' } });

    expect(refused.isError).toBe(true);
    expect(errorOf(await s.registry.execute(s.ctx, 'move_task', { task_id: 'task-1', to_state_id: 's-done' })).code).toBe('validation');

    await s.client.close();
    await s.server.close();
  });
});
