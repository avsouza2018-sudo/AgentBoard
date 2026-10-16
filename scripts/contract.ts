import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiDocument, toolContract } from '@agentboard/adapters';

/**
 * Both contract files are generated from the registry, never written by hand. `pnpm contract`
 * writes them; the contract tests compare the committed files with freshly generated ones, so a
 * tool that changes shape — or gains, loses, or repoints its route — fails the build until the
 * contract is regenerated on purpose.
 */
const write = (name: string, value: unknown): void => {
  const out = fileURLToPath(new URL(`../contracts/${name}`, import.meta.url));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(value, null, 2)}\n`);
};

const contract = toolContract();
const doc = openApiDocument() as { paths: Record<string, unknown> };

write('mcp-tools.json', contract);
write('openapi.json', doc);

process.stdout.write(`contracts/mcp-tools.json (${contract.length} tools, routes included)\n`);
process.stdout.write(`contracts/openapi.json (${Object.keys(doc.paths).length} paths)\n`);
