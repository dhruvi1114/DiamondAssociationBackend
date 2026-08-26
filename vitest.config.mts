import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

/**
 * Unit and integration tests (testing-strategy.md §3).
 *
 * `vite-tsconfig-paths` reuses the `@modules` / `@constant` aliases already in
 * tsconfig rather than restating them here, so a new alias never has to be added
 * in two places.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
