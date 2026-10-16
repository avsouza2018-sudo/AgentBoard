import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { err, id, type BoardId, PermissionError } from '@agentboard/shared';
import type { Application } from '@agentboard/application';
import type { ToolContext } from '../toolContext.js';
import type { ToolRegistry } from '../toolRegistry.js';
import { renderHttp, type HttpResponse } from '../errorMapping.js';
import { outcomeOf } from '../toolOutcome.js';
import { bearerToken, handleMcpRequest } from '../mcp/http.js';
import { toolContract } from '../tools/index.js';
import { buildRouteTable, type RouteEntry } from './routes.js';
import { handleApiRequest, type ApiDeps, type ApiRequest } from './router.js';
import type { OutboxStream } from './sse.js';
import { openApiDocument } from './openapi.js';

/**
 * The HTTP surface. It is thin on purpose: every request becomes one tool call through the same
 * registry the MCP transports use, and every response is rendered by the same error table. There
 * is no second validation layer, no second auth path, and no second error taxonomy here — those
 * are what would let the REST surface drift from the agent surface.
 */
export interface ApiOptions {
  readonly app: Application;
  readonly registry: ToolRegistry;
  /** Fed by the outbox port, not by a hook inside the use cases. */
  readonly stream: OutboxStream;
  /** Turns a token into an identity. The same `ActorResolver` the tools use. */
  readonly resolve: (request: ApiRequest) => ToolContext | null;
}

export interface ApiServer {
  readonly server: Server;
  readonly routes: readonly RouteEntry[];
  readonly stream: OutboxStream;
  close(): void;
}

export function startApiServer(opts: ApiOptions, port = 0): ApiServer {
  const routes = buildRouteTable(opts.registry.tools);
  const deps: ApiDeps = { registry: opts.registry, routes, resolve: opts.resolve };

  const server = createServer((req, res) => {
    handle(req, res, opts, deps, routes).catch((error: unknown) => {
      writeRendered(res, {
        status: 500,
        body: { error: { code: 'conflict', message: error instanceof Error ? error.message : String(error), details: {}, retryable: false } },
        headers: {},
      });
    });
  });

  server.listen(port);
  opts.stream.start();

  return {
    server,
    routes,
    stream: opts.stream,
    close() {
      opts.stream.stop();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
  deps: ApiDeps,
  routes: readonly RouteEntry[],
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Descriptions of the surface, not board data: the same definitions the tools serve.
  if (path === '/health') {
    writeRendered(res, { status: 200, body: { status: 'ok', tools: routes.length, routes: routes.length }, headers: {} });
    return;
  }
  if (path === '/api/contract') {
    writeRendered(res, { status: 200, body: { tools: toolContract() }, headers: {} });
    return;
  }
  if (path === '/api/openapi.json') {
    writeRendered(res, { status: 200, body: openApiDocument(), headers: {} });
    return;
  }

  // The same registry serves both surfaces on one port. The MCP handler gets identity from the
  // same resolver, so a token means the same thing on `/mcp` and on `/api`.
  if (path === '/mcp') {
    await handleMcpRequest(req, res, {
      registry: opts.registry,
      authenticate: (token) => opts.resolve({ method: 'POST', path: '/mcp', token, runId: runIdOf(req), query: {}, body: undefined }),
    });
    return;
  }

  const boardId = eventBoard(path);
  if (boardId) {
    await handleEvents(req, res, opts, deps, boardId);
    return;
  }

  const request = await requestFrom(req, url);
  const rendered = await handleApiRequest(request, deps);

  // Dispatch after the use case returned, which is after its transaction committed: a row in the
  // outbox is a row a committed transaction wrote. Doing this before writing the response is what
  // makes the stream observable in a test without a timer.
  await opts.stream.dispatch();

  writeRendered(res, rendered);
}

async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ApiOptions,
  deps: ApiDeps,
  boardId: BoardId,
): Promise<void> {
  const request: ApiRequest = {
    method: 'GET',
    path: req.url ?? '/',
    token: bearerToken(req),
    runId: runIdOf(req),
    query: {},
    body: undefined,
  };

  const ctx = deps.resolve(request);
  if (!ctx) {
    const denied = outcomeOf(err(new PermissionError('a bearer token is required', { path: request.path })));
    writeRendered(res, renderHttp(denied));
    return;
  }

  // The adapter does not decide visibility by itself: it asks the facade which boards this token
  // can see, through the same query an agent would call.
  const who = await opts.app.whoAmI.execute(ctx);
  if (!who.ok) {
    writeRendered(res, renderHttp(outcomeOf(who)));
    return;
  }

  const visible = ((who.value as { boards: { id: string }[] }).boards).map((b) => b.id);
  if (!visible.includes(boardId)) {
    const denied = outcomeOf(err(new PermissionError(`token cannot see board ${boardId}`, { boardId, visible })));
    writeRendered(res, renderHttp(denied));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();

  const sub = opts.stream.subscribe(boardId, (frame) => res.write(frame));
  res.write(`event: connected\ndata: ${JSON.stringify({ boardId, subscriber: sub.id })}\n\n`);
  await opts.stream.dispatch();

  req.on('close', () => sub.unsubscribe());
}

function eventBoard(path: string): BoardId | null {
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length !== 4 || segments[0] !== 'api' || segments[1] !== 'boards' || segments[3] !== 'events') return null;
  return id<BoardId>(segments[2] as string);
}

async function requestFrom(req: IncomingMessage, url: URL): Promise<ApiRequest> {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    token: bearerToken(req),
    runId: runIdOf(req),
    query: Object.fromEntries(url.searchParams.entries()),
    body: (req.method ?? 'GET').toUpperCase() === 'GET' ? undefined : await readJson(req),
  };
}

function runIdOf(req: IncomingMessage): string | null {
  const header = req.headers['x-run-id'];
  return typeof header === 'string' && header !== '' ? header : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

function writeRendered(res: ServerResponse, rendered: HttpResponse): void {
  res.writeHead(rendered.status, { 'content-type': 'application/json', ...rendered.headers });
  res.end(JSON.stringify(rendered.body));
}
