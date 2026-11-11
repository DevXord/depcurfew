import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup/no-network.ts', 'tests/setup/no-user-cache.ts', 'tests/setup/no-user-registries.ts'],
    // The time limits of the tests measure CPU time (tests/support/cpu-time.ts), so the clock must not decide first:
    // Vitest's defaults of 5 s and 10 s failed tests and hooks on busy Windows runners (decision D-198).
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
