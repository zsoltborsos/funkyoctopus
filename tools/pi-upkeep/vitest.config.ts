import { defineConfig } from 'vitest/config';

// Own vitest project for the quarantined embedded-pi promotion engine: node
// environment, no jsdom, no browser setup file. `dir` anchors discovery to
// this directory so `npm run test:tools` never sweeps the repository (and
// never the opt-in *.runtime.test.ts suites).
export default defineConfig({
  test: {
    environment: 'node',
    dir: import.meta.dirname,
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.runtime.test.ts'],
  },
});
