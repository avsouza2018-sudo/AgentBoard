import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ContextResolver, ToolContext } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { createMcpServer } from './protocol.js';

/**
 * Stateless MCP over HTTP: one protocol instance per request, and the context is bound to
 * that request only. A session that outlives the request cannot inherit another agent's
 * token, which is the failure mode a shared session would allow.
 *
 * The transport does not authenticate. It forwards the bearer token to the same
 * `ActorResolver` the application uses, so "unknown token" is one answer everywhere rather
 * than a second auth path. A deployment that wants 401 at the edge can put middleware in
 * front of this handler without changing anything below it.
 */
export interface HttpMcpOptions {
  registry: ToolRegistry;
  /** Turns a header into an identity. The registry turns an identity into an actor. */
  authenticate: (token: string | null) => ToolContext | null;
  health?: (req: IncomingMessage, res: ServerResponse) => void;
}

export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token === '' ? null : token;
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, opts: HttpMcpOptions): Promise<void> {
  if (req.method !== 'POST') {
    // A stateless endpoint has no session to stream to.
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'validation', message: `${req.method} is not supported on a stateless MCP endpoint`, details: { path: '/mcp' }, retryable: false } }));
    return;
  }

  const ctx = opts.authenticate(bearerToken(req));
  const resolver: ContextResolver = () => ctx;
  const server = createMcpServer(opts.registry, resolver);

  // Stateless: no sessionIdGenerator, so no session outlives the request. The SDK declares
  // `sessionId` as `string` on Transport while a stateless transport has none, which
  // `exactOptionalPropertyTypes` cannot reconcile — the cast states the stateless case.
  const transport = new StreamableHTTPServerTransport();

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res);
  } finally {
    await transport.close();
    await server.close();
  }
}

export function startMcpHttpServer(opts: HttpMcpOptions, port = 0) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: opts.registry.tools.length }));
      return;
    }
    handleMcpRequest(req, res, opts).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    });
  });
  server.listen(port);
  return server;
}
