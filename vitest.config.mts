import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
});
