import { HTTP_STATUS } from '../errorMapping.js';
import { toolContract, type ToolContractEntry } from '../tools/index.js';

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/**
 * The OpenAPI document is generated from the same tool definitions the MCP surface serves, so it
 * cannot describe a surface that no longer exists. Every path, every parameter, every status code
 * in here comes from the registry and from the error table — nothing is typed by hand.
 *
 * Two things worth naming in the document itself: `x-use-case` records which use case a route
 * calls (the same fact the contract test asserts), and `x-error-codes` is the status table, so a
 * client reading the API description sees the same code→status mapping the adapter uses.
 */
export function openApiDocument(): Record<string, unknown> {
  const contract = toolContract();
  const paths: Record<string, unknown> = {};

  for (const entry of contract) {
    const properties = (entry.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = (entry.inputSchema.required ?? []) as string[];
    const pathArgs = [...entry.route.path.matchAll(PLACEHOLDER)].map((m) => m[1] as string);

    const operation: Record<string, unknown> = {
      operationId: entry.name,
      summary: entry.title,
      description: entry.description,
      'x-use-case': entry.useCase,
      'x-annotations': entry.annotations,
      responses: {
        '200': {
          description: entry.kind === 'read' ? 'The read result.' : 'The result of the write, including the events it produced.',
          content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: {} } } } },
        },
        default: {
          description: 'A refusal. The status comes from the same table the MCP adapter renders through.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    };

    if (entry.route.method === 'GET') {
      operation.parameters = [
        ...pathArgs.map((name) => ({ name, in: 'path', required: true, schema: properties[name] })),
        ...Object.entries(properties)
          .filter(([name]) => !pathArgs.includes(name))
          .map(([name, schema]) => ({ name, in: 'query', required: required.includes(name), schema })),
      ];
    } else {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !pathArgs.includes(name))),
              required: required.filter((name) => !pathArgs.includes(name)),
              additionalProperties: false,
            },
          },
        },
      };
    }

    // Two tools can share a path (`GET /api/tasks/{task_id}` and `POST /api/tasks/{task_id}`), so
    // the path accumulates methods instead of being reassigned by whichever tool came last.
    const existing = (paths[entry.route.path] as Record<string, unknown> | undefined) ?? {};
    paths[entry.route.path] = { ...existing, [entry.route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'AgentBoard HTTP API',
      version: '0.5.0',
      description:
        'The same tool surface an agent uses, served over HTTP. Routes are generated from the tool registry, so this document and the MCP tools/list cannot disagree.',
    },
    security: [{ bearer: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'A per-agent token, resolved by the same ActorResolver the tools use.' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['code', 'message', 'details', 'retryable'],
          properties: {
            code: { type: 'string', enum: Object.keys(HTTP_STATUS).sort() },
            message: { type: 'string' },
            details: { type: 'object' },
            retryable: { type: 'boolean' },
          },
        },
      },
    },
    'x-error-codes': HTTP_STATUS,
    'x-tool-count': contract.length,
    paths,
  };
}
