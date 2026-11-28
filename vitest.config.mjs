import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@fyso/panel': fileURLToPath(new URL('./panel-src/__tests__/panel-sdk.jsx', import.meta.url)),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'jsdom',
    include: ['panel-src/__tests__/*.test.{jsx,mjs}'],
  },
});
