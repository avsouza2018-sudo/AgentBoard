import { z } from 'zod';
import type { RouteSpec, ToolDefinition } from '../toolRegistry.js';

/**
 * A tool plus the arguments its path carries. Built once, at composition time, from the tool
 * definitions themselves — never beside them.
 *
 * Three things are checked here, because they are the three ways a REST surface drifts from the
 * tool surface: a tool with no route, a write exposed as GET, and a path that reads an argument
 * the tool does not accept. All three fail at build time, not at request time.
 */
export interface RouteEntry {
  readonly tool: ToolDefinition;
  readonly route: RouteSpec;
  /** Argument names the path carries, in the order they appear. */
  readonly pathArgs: readonly string[];
  /** JSON-schema node per argument, so a query string can be coerced without inventing a value. */
  readonly properties: Record<string, unknown>;
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function buildRouteTable(tools: readonly ToolDefinition[]): RouteEntry[] {
  return tools.map((tool) => {
    const route = tool.route;
    if (!route?.path) throw new Error(`tool '${tool.name}' has no HTTP route`);

    const expected = tool.kind === 'read' ? 'GET' : 'POST';
    if (route.method !== expected) {
      throw new Error(`tool '${tool.name}' is a ${tool.kind} tool but is served as ${route.method}`);
    }

    const schema = z.toJSONSchema(tool.inputSchema) as { properties?: Record<string, unknown> };
    const properties = schema.properties ?? {};
    const pathArgs = [...route.path.matchAll(PLACEHOLDER)].map((m) => m[1] as string);

    for (const arg of pathArgs) {
      if (!(arg in properties)) {
        throw new Error(`route '${route.path}' reads '{${arg}}', which '${tool.name}' does not accept`);
      }
    }

    return { tool, route, pathArgs, properties };
  });
}

export interface MatchedRoute {
  entry: RouteEntry;
  params: Record<string, string>;
}

/**
 * Method is part of the match, not just the path: `GET /api/tasks/{task_id}` is the read tool and
 * `POST /api/tasks/{task_id}` is the write tool, and they are different tools. Passing `null` as
 * the method matches the path alone, which is how the router tells 405 from 404.
 */
export function matchRoute(routes: readonly RouteEntry[], method: string | null, pathname: string): MatchedRoute | null {
  const segments = pathname.split('/').filter((s) => s !== '');

  for (const entry of routes) {
    if (method !== null && entry.route.method !== method) continue;
    const template = entry.route.path.split('/').filter((s) => s !== '');
    if (template.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < template.length; i++) {
      const part = template[i] as string;
      const value = segments[i] as string;
      if (part.startsWith('{') && part.endsWith('}')) params[part.slice(1, -1)] = value;
      else if (part !== value) {
        matched = false;
        break;
      }
    }
    if (matched) return { entry, params };
  }

  return null;
}

/**
 * Path arguments win over a body that names the same argument. The URL is what the caller was
 * actually asked about; a body that disagrees is a client bug, not a second source of truth.
 */
export function argsFromRequest(match: MatchedRoute, source: Record<string, unknown>): Record<string, unknown> {
  return { ...source, ...match.params };
}

/**
 * A query string is all strings, so it has to be coerced. The coercion reads the type from the
 * same schema that validates the call, and when a value cannot be coerced it is passed through
 * unchanged — the schema then produces the validation error. The adapter never decides what an
 * invalid number is; the definition does.
 */
export function coerceQuery(match: MatchedRoute, query: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(query)) {
    const node = match.entry.properties[key] as { type?: string | string[] } | undefined;
    if (!node) {
      args[key] = raw;
      continue;
    }

    const type = node.type;
    if (type === 'integer' || type === 'number') {
      const n = Number(raw);
      args[key] = Number.isNaN(n) ? raw : n;
    } else if (type === 'boolean') {
      args[key] = raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : raw;
    } else if (type === 'array') {
      args[key] = raw.split(',');
    } else if (Array.isArray(type) && type.includes('null')) {
      args[key] = raw === 'null' ? null : raw;
    } else {
      args[key] = raw;
    }
  }

  return args;
}
