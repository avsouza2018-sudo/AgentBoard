/**
 * Composition root for the HTTP surface. Same registry, same resolver, one port: the REST routes
 * are generated from the tool definitions, `/mcp` serves the protocol from the same definitions,
 * and the live stream is fed by the outbox port. Nothing here validates, authorises, or maps an
 * error itself — that would be the second surface the whole design exists to prevent.
 */
import { buildApplication } from '@agentboard/application';
import { id, type RunId } from '@agentboard/shared';
import { buildToolRegistry, OutboxStream, startApiServer, type ApiRequest, type ToolContext } from '@agentboard/adapters';
import { actorLookup, chooseWiring } from '../../composition.js';

async function main(): Promise<void> {
  const wiring = await chooseWiring();
  const app = buildApplication(wiring.deps);
  const registry = buildToolRegistry(app, { limiter: wiring.limiter, log: wiring.log, clock: wiring.deps.clock });

  const stream = new OutboxStream(wiring.outbox, { intervalMs: Number(process.env.STREAM_INTERVAL_MS ?? 250) });

  const lookup = actorLookup(wiring.deps);
  const resolve = async (request: ApiRequest): Promise<ToolContext | null> =>
    request.token === null ? null : { actorToken: request.token, runId: request.runId ? id<RunId>(request.runId) : null, actorId: await lookup(request.token) };

  const port = Number(process.env.PORT ?? 3000);
  const api = startApiServer({ app, registry, stream, resolve }, port);
  const address = api.server.address();

  process.stderr.write(
    `agentboard api: http on ${typeof address === 'object' && address ? address.port : port} (rest + mcp + sse)\n`,
  );

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      api.close();
      process.exit(0);
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`agentboard api: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
