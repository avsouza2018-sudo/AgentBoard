import { z } from 'zod';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server';
import { PermissionError } from '@agentboard/shared';
import type { ContextResolver, RequestContext } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { renderMcp } from '../errorMapping.js';
import { toToolError } from '../toolOutcome.js';

export const SERVER_INFO = { name: 'agentboard', version: '0.1.0' };

export const INSTRUCTIONS =
  'AgentBoard is a task board for AI agents. Transitions only exist along the workflow graph; ' +
  'human-gate states, WIP limits, open blockers and leases are enforced by the server, not by convention. ' +
  'Read who_am_i and get_board_snapshot before writing, and give every write a reason.';

/**
 * The protocol half: JSON-RPC handlers that read the registry. Nothing here knows whether it
 * is talking to stdin or to a socket — the transports are thin shells around this. Keeping the
 * registry out of the transport is what makes `tools/list` identical on both.
 */
export function createMcpServer(registry: ToolRegistry, resolveContext: ContextResolver): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: registry.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const ctx = await resolveContext({ sessionId: extra.sessionId });
    if (!ctx) {
      return renderMcp({
        ok: false,
        error: toToolError(new PermissionError('no actor token for this request', { tool: request.params.name })),
      });
    }
    return renderMcp(await registry.execute(ctx, request.params.name, request.params.arguments ?? {}));
  });

  return server;
}
