/**
 * Composition root for the agent connection. It wires infra adapters into the application's ports,
 * hands the application to the tool registry, and picks a transport. Nothing below this file
 * chooses a storage or a transport.
 */
import { buildApplication } from '@agentboard/application';
import { id, type RunId } from '@agentboard/shared';
import { buildToolRegistry, contextFromEnvironment, runStdio, startMcpHttpServer } from '@agentboard/adapters';
import { actorLookup, chooseWiring } from '../../composition.js';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string, fallback: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};

async function main(): Promise<void> {
  const wiring = await chooseWiring();
  const app = buildApplication(wiring.deps);
  const registry = buildToolRegistry(app, { limiter: wiring.limiter, log: wiring.log, clock: wiring.deps.clock });

  const lookup = actorLookup(wiring.deps);
  const runId = process.env.AGENTBOARD_RUN_ID ? id<RunId>(process.env.AGENTBOARD_RUN_ID) : null;

  if (has('--http')) {
    const port = Number(valueOf('--http', '3001'));
    const server = startMcpHttpServer({
      registry,
      authenticate: async (token) => (token === null ? null : { actorToken: token, runId, actorId: await lookup(token) }),
    }, port);
    const address = server.address();
    process.stderr.write(`agentboard mcp: http on ${typeof address === 'object' && address ? address.port : port}\n`);
    return;
  }

  await runStdio(registry, contextFromEnvironment(process.env, lookup));
}

main().catch((error: unknown) => {
  process.stderr.write(`agentboard mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
