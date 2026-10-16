import { z } from 'zod';
import type { Application } from '@agentboard/application';
import { createToolRegistry, type RouteSpec, type ToolAnnotations, type ToolDefinition, type ToolKind, type ToolRegistry } from '../toolRegistry.js';
import { READ_TOOLS } from './readTools.js';
import { WRITE_TOOLS } from './writeTools.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function buildToolRegistry(app: Application): ToolRegistry {
  return createToolRegistry(app, TOOL_DEFINITIONS);
}

/**
 * The machine-readable shape of the surface: name, description, annotations, argument schema,
 * and the route the HTTP API serves it on. `contracts/mcp-tools.json` is a snapshot of this, and the
 * contract test fails if the registry and the snapshot disagree — that is the lock. The OpenAPI
 * document for the HTTP API is generated from the same definitions, so the two surfaces
 * cannot drift apart: a tool that gains a route, loses one, or changes shape fails the build.
 */
export interface ToolContractEntry {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  route: RouteSpec;
  useCase: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
}

export function toolContract(): ToolContractEntry[] {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    route: tool.route,
    useCase: String(tool.useCase),
    annotations: tool.annotations,
    inputSchema: z.toJSONSchema(tool.inputSchema),
  })).sort((a, b) => a.name.localeCompare(b.name));
}
