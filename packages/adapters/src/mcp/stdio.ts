import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RunId } from '@agentboard/shared';
import { id } from '@agentboard/shared';
import type { ContextResolver, ToolContext } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { createMcpServer } from './protocol.js';

/**
 * One identity per process for stdio: the transport has no per-request headers, so the token
 * is fixed for the lifetime of the connection. That is also the honest reading of stdio — a
 * client that pipes stdin is one agent, not many.
 */
export function contextFromEnvironment(env: NodeJS.ProcessEnv = process.env): ContextResolver {
  const token = env.AGENTBOARD_TOKEN ?? '';
  const run = env.AGENTBOARD_RUN_ID ?? '';
  const ctx: ToolContext | null = token ? { actorToken: token, runId: run ? id<RunId>(run) : null } : null;
  return () => ctx;
}

export async function runStdio(registry: ToolRegistry, resolveContext: ContextResolver): Promise<void> {
  const server = createMcpServer(registry, resolveContext);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; anything written here is a log, not a message.
  process.stderr.write(`agentboard mcp: stdio ready (${registry.tools.length} tools)\n`);
}
