import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // Live E2E tests hit the real Kiro upstream and consume token quota,
    // so they must be kept out of the default `pnpm test` / pre-commit
    // pipeline. Run them explicitly via `pnpm test:e2e`.
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
});
