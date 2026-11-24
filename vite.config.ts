import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@features': fileURLToPath(new URL('./src/features', import.meta.url)),
    },
  },
  // Dev is pinned to 14174 with strictPort so a busy port fails loudly instead
  // of silently moving the browser to an Origin the sidecar rejects — and so
  // development never sits on the installed service's port/origin
  // (sidecar 14787, served UI on http://127.0.0.1:14787).
  server: {
    port: 14174,
    strictPort: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'browser',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          css: true,
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, '**/*.runtime.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          include: ['server/**/*.test.ts', 'scripts/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: [...configDefaults.exclude, '**/*.runtime.test.ts'],
        },
      },
    ],
  },
});
