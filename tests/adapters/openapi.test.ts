import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS, openApiDocument, toolContract } from '@agentboard/adapters';

const OPENAPI_PATH = fileURLToPath(new URL('../../contracts/openapi.json', import.meta.url));

interface Operation {
  operationId: string;
  'x-use-case': string;
}

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: { Error: { properties: { code: { enum: string[] } } } } };
  'x-error-codes': Record<string, number>;
  'x-tool-count': number;
}

const document = () => openApiDocument() as unknown as Document;

describe('the OpenAPI contract', () => {
  it('is generated from the registry, not described beside it', () => {
    const committed = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as Document;
    expect(committed).toEqual(document());
  });

  it('describes exactly the routes the tool definitions carry', () => {
    const doc = document();
    const described = Object.entries(doc.paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${path}`))
      .sort();
    const defined = toolContract().map((t) => `${t.route.method.toLowerCase()} ${t.route.path}`).sort();

    expect(described).toEqual(defined);
    expect(doc['x-tool-count']).toBe(toolContract().length);
  });

  it('names the use case behind every route, the same fact the routing test asserts', () => {
    const doc = document();
    const byRoute = new Map<string, string>();
    for (const entry of toolContract()) byRoute.set(`${entry.route.method.toLowerCase()} ${entry.route.path}`, entry.useCase);

    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(`${method} ${path}`, op.operationId).toBe(`${method} ${path}`);
        expect(op['x-use-case'], op.operationId).toBe(byRoute.get(`${method} ${path}`));
      }
    }
  });

  it('lists the status codes from the same table the adapter renders through', () => {
    const doc = document();
    expect(doc['x-error-codes']).toEqual(HTTP_STATUS);
    expect(doc.components.schemas.Error.properties.code.enum).toEqual(Object.keys(HTTP_STATUS).sort());
  });
});
