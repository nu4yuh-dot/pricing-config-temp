import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.ts'],
    environment: 'node',
    /**
     * Vitest defaults to five seconds, which is a default rather than a budget anybody
     * chose. Several tests here diff a whole rate card, and `diffCardData` renders every
     * tab against both versions — around 180 ms on an idle machine, and multiples of that
     * when forty-nine files run in parallel. They were failing on the clock while
     * asserting the right answer.
     *
     * The rendering cost is worth attacking on its own; it is not worth failing a correct
     * test over in the meantime.
     */
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
});
