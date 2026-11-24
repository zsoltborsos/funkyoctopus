import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Anchored to server/: agent run worktrees nested in the checkout carry copies.
    include: ['server/**/*.runtime.test.ts'],
    // Real model turns are capped per-turn in the suite; these are ceilings.
    testTimeout: 600_000,
    hookTimeout: 180_000,
    // One long suite at a time: the model pin and global state are shared.
    fileParallelism: false,
  },
});
