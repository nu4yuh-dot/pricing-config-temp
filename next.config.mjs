/** @type {import('next').NextConfig} */
const config = {
  /**
   * Emits .next/standalone with only the files and node_modules the server actually
   * needs, so the container image stays small and the build's devDependencies
   * (playwright, vitest, tsx) never ship to production.
   */
  output: 'standalone',

  experimental: {
    // Server actions receive whole edit batches from a paste, a fill-down or a bulk
    // rate change, which can be a few thousand cells.
    serverActions: { bodySizeLimit: '4mb' },
  },

  // The repo sits inside a directory that has its own lockfile; be explicit so the
  // standalone trace roots here and not a parent.
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
