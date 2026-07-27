import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `include` is an allowlist of the source trees rather than the default
 * `**\/*.test.ts`: the default also walks `.next`, which is build output, and a
 * test runner should never depend on whether that directory happens to exist.
 * The `@` alias mirrors tsconfig's `paths` so a test can import app modules the
 * same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['app/**/*.test.ts', 'lib/**/*.test.ts', 'inngest/**/*.test.ts'],
  },
});
