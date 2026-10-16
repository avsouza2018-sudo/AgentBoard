import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@agentboard/shared': p('./packages/shared/src/index.ts'),
      '@agentboard/domain': p('./packages/domain/src/index.ts'),
      '@agentboard/application': p('./packages/application/src/index.ts'),
      '@agentboard/infra': p('./packages/infra/src/index.ts'),
      '@agentboard/adapters': p('./packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests start a container in a hook, which is slower than a test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
