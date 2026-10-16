/**
 * Enforces the dependency rule. This is not decoration: `pnpm dep-check` fails the build
 * if a layer reaches outward.
 *
 * `from.pathNot: 'node_modules'` keeps pnpm workspace symlinks (packages/infra/node_modules/...)
 * from being mistaken for the package that owns them.
 */
const NOT_IN_NODE_MODULES = 'node_modules';

/**
 * `dependencyTypesNot` is how a rule says "external packages and node builtins are fine here".
 * Matching on the bare module name does not work: dependency-cruiser reports `node:fs` as `fs`,
 * and a package inside pnpm's symlinked store as `unknown` because it cannot resolve the file.
 * Both are allowed for adapter packages; the domain and application rules keep forbidding them,
 * which is what stops zod from creeping inward.
 */
const EXTERNAL = ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-unknown', 'npm-no-pkg', 'npm-bundled', 'core', 'unknown'];

module.exports = {
  forbidden: [
    {
      name: 'shared-is-leaf',
      comment: 'The shared kernel depends on nothing.',
      severity: 'error',
      from: { path: '^packages/shared', pathNot: NOT_IN_NODE_MODULES },
      to: { pathNot: ['^packages/shared', '^node_modules', 'node_modules'] },
    },
    {
      name: 'domain-is-leaf',
      comment: 'Domain may import only itself and the shared kernel. No I/O, no framework, no zod.',
      severity: 'error',
      from: { path: '^packages/domain', pathNot: NOT_IN_NODE_MODULES },
      to: { pathNot: ['^packages/domain', '^packages/shared', '^node_modules', 'node_modules'] },
    },
    {
      name: 'application-uses-domain-and-ports-only',
      comment: 'Application may import domain, shared, and its own ports. Never an adapter.',
      severity: 'error',
      from: { path: '^packages/application', pathNot: NOT_IN_NODE_MODULES },
      to: {
        pathNot: ['^packages/application', '^packages/domain', '^packages/shared', '^node_modules', 'node_modules'],
      },
    },
    {
      name: 'storage-adapters-point-inward-only',
      comment: 'Infra implements domain ports; it must not import application internals. External packages and node builtins are allowed here — the adapter is where I/O lives.',
      severity: 'error',
      from: { path: '^packages/infra', pathNot: NOT_IN_NODE_MODULES },
      to: {
        pathNot: ['^packages/infra', '^packages/domain', '^packages/shared'],
        dependencyTypesNot: EXTERNAL,
      },
    },
    {
      name: 'transport-adapters-point-inward-only',
      comment: 'The MCP surface calls the application facade and nothing else. If a tool could reach a repository, the tool surface and the HTTP surface would drift the moment one of them took a shortcut — and the tool could not be served over HTTP at all. The transport package is allowed its own external dependencies.',
      severity: 'error',
      from: { path: '^packages/adapters', pathNot: NOT_IN_NODE_MODULES },
      to: {
        pathNot: ['^packages/adapters', '^packages/application', '^packages/domain', '^packages/shared'],
        dependencyTypesNot: EXTERNAL,
      },
    },
    {
      name: 'composition-root-wires-everything',
      comment: 'The composition root is the only place allowed to see every layer at once. It chooses storage and transport; nothing below it does.',
      severity: 'error',
      from: { path: '^apps', pathNot: NOT_IN_NODE_MODULES },
      to: {
        pathNot: ['^apps', '^packages'],
        dependencyTypesNot: EXTERNAL,
      },
    },
    {
      name: 'web-consumes-the-contract-only',
      comment: 'The browser is a client of the HTTP contract, not a consumer of the domain. If the UI imported a domain class it would depend on the shape of an aggregate instead of the shape of a response, and the mirror in apps/web/src/contract.ts would stop being true. React and its own files are all it may reach.',
      severity: 'error',
      from: { path: '^apps/web', pathNot: NOT_IN_NODE_MODULES },
      to: {
        pathNot: ['^apps/web', '^node_modules', 'node_modules'],
        dependencyTypesNot: EXTERNAL,
      },
    },
    {
      name: 'no-circular-deps',
      comment: 'Layers must not import back outward.',
      severity: 'error',
      from: { path: '^packages', pathNot: NOT_IN_NODE_MODULES },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
  },
};
