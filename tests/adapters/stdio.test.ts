import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AGENT_TOKEN, BOARD } from '../harness.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The real entrypoint, spawned as a process. Everything else in this suite calls the registry
 * in-process; this is the only test that proves the stdio transport works when the server is a
 * separate process reading a pipe — which is how every MCP client actually starts it.
 */
async function connect(env: Record<string, string>) {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['--import', 'tsx', 'apps/mcp-server/src/main.ts'],
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  await client.connect(transport);
  return { client, transport };
}

describe('the stdio transport', () => {
  it('serves the contract over a pipe', async () => {
    const { client, transport } = await connect({ AGENTBOARD_TOKEN: AGENT_TOKEN, AGENTBOARD_RUN_ID: 'run-stdio' });

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(15);

    const who = await client.callTool({ name: 'who_am_i', arguments: {} });
    expect((who.structuredContent as { actor: { id: string } }).actor.id).toBe('agent-atlas');

    const created = await client.callTool({ name: 'create_task', arguments: { board_id: 'board-1', title: 'via pipe' } });
    expect(created.isError).toBeFalsy();

    await client.close();
    await transport.close();
  });

  it('refuses an agent write with no run id, the same way it does over HTTP', async () => {
    const { client, transport } = await connect({ AGENTBOARD_TOKEN: AGENT_TOKEN });

    const refused = await client.callTool({ name: 'create_task', arguments: { board_id: 'board-1', title: 'no provenance' } });

    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as { error: { code: string } }).error.code).toBe('validation');

    await client.close();
    await transport.close();
  });
});
