import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RunId } from '@agentboard/shared';
import { id } from '@agentboard/shared';
import type { ActorLookup, ContextResolver } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { createMcpServer } from './protocol.js';

/**
 * One identity per process for stdio: the transport has no per-request headers, so the token
 * is fixed for the lifetime of the connection. That is also the honest reading of stdio — a
 * client that pipes stdin is one agent, not many.
 *
 * `identify` is required rather than optional. The transport is what names the actor in the log, and
 * a transport that could produce a context without an actor id would produce log lines that describe
 * a caller they cannot point at — the one thing the operational log exists to answer.
 */
export function contextFromEnvironment(env: NodeJS.ProcessEnv, identify: ActorLookup): ContextResolver {
  const token = env.AGENTBOARD_TOKEN ?? '';
  const run = env.AGENTBOARD_RUN_ID ?? '';
  if (!token) return () => null;

  return async () => ({
    actorToken: token,
    runId: run ? id<RunId>(run) : null,
    // Unknown here, resolved by the use case: the transport does not decide legality, it only names
    // who is calling. A transport that refused an unknown token itself would be a second auth path.
    actorId: await identify(token),
    transport: 'stdio',
  });
}

export async function runStdio(registry: ToolRegistry, resolveContext: ContextResolver): Promise<void> {
  const server = createMcpServer(registry, resolveContext);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; anything written here is a log, not a message.
  process.stderr.write(`agentboard mcp: stdio ready (${registry.tools.length} tools)\n`);
}
