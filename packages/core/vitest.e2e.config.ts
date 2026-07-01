/**
 * Vitest config for live end-to-end tests.
 *
 * Used ONLY by `pnpm test:e2e`. Unlike `vitest.config.ts` (which
 * deliberately excludes `test/e2e/**`), this config scopes itself to the
 * e2e directory and bumps the per-test timeout because real upstream
 * vision/websearch calls can easily run 10-30s per request.
 *
 * Running:
 *   KIRO2CLAUDE_API_KEY=... KIRO2CLAUDE_SQLITE_DB_PATH=... pnpm test:e2e
 *
 * Tests auto-skip when those env vars are unset (see live.test.ts).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // 上游 model 行为有客观 flake——同样 prompt 在 N 次跑里 model 可能自决跳过
    // reasoning / tool 1-2 次。e2e 重试 2 次几乎消除假阴性，避免"用更强 prompt
    // 强行调测试通过"那种作弊行为。每次 retry 消耗真实 token quota，但 e2e 本来
    // 就是 token-paid 路径，可接受。
    retry: 2,
  },
});
