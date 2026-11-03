import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/no-network.ts', 'tests/setup/no-user-cache.ts'],
  },
});
