import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only. tests/e2e.ts drives the real HTTP API against a running
    // server and is run separately with `npm run test:e2e`, so it is not picked
    // up here — a unit run must not depend on a live process.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    // Financial logic is pure; no setup file or database is needed.
    reporters: ['default'],
  },
});
