/**
 * Static guard: 守卫 kiro-cli 版本号"唯一真相源"架构不被悄悄回退。
 *
 * ## 设计前提
 *
 * `fixtures/kiro-cli-profile.json` 的 `kiroCliVersion` 字段是版本号的
 * **唯一真相源**。其它地方都从它派生或显式 mark 为"不是版本号副本"：
 *
 *   - `Dockerfile` 顶部 `ARG KIRO2CLAUDE_CLI_VERSION` 故意**没有默认值**——
 *     build 时必须由 `pnpm docker:build` wrapper（读 fixture）或显式
 *     `--build-arg` 提供。直接 `docker build .` 会 fail-fast。
 *   - `src/kiro/client-profile.ts` 的 `FALLBACK_PROFILE.kiroCliVersion`
 *     固定为 `'unknown'`——它是 fixture 缺失时的兜底快照，触发时显示具体
 *     版本号反而误导。
 *
 * 这条测试守卫这两个"激进清理"决策不被无意中回退：有人提交把 ARG 写回
 * `=2.5.0`，或把 FALLBACK 写回 `'2.5.0'`，都会被 pre-commit 拦下。
 *
 * ## 同时校验 fixture 自身合法性
 *
 * fixture 必须存在合法的 semver 风格 `kiroCliVersion` 字段——否则
 * `pnpm docker:build` 会拿到空字符串。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// test/static/ → packages/core/ → ../../.. = workspace root
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');

const DOCKERFILE_PATH = path.join(REPO_ROOT, 'docker', 'Dockerfile');
const FIXTURE_PATH = path.join(REPO_ROOT, 'fixtures', 'kiro-cli-profile.json');
const CLIENT_PROFILE_TS = path.join(PACKAGE_ROOT, 'src', 'kiro', 'client-profile.ts');

describe('static guard: kiro-cli single-source-of-truth', () => {
  it('fixture has a valid semver-shaped kiroCliVersion (the source of truth)', () => {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `fixtures/kiro-cli-profile.json 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    expect(parsed, 'fixture root must be object').toBeTruthy();
    const v = (parsed as Record<string, unknown>).kiroCliVersion;
    expect(typeof v, 'fixture.kiroCliVersion must be string').toBe('string');
    expect(v).not.toBe('');
    expect(v).not.toBe('unknown');
    expect(v as string).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it('Dockerfile ARG KIRO2CLAUDE_CLI_VERSION has no default value (must be provided by wrapper)', () => {
    const source = fs.readFileSync(DOCKERFILE_PATH, 'utf-8');
    // 在顶部全局 ARG 段查找。允许行末可选空格 / 注释，但必须没有 `=...`。
    const lines = source.split('\n');
    let topLevelArg: string | undefined;
    for (const line of lines) {
      const m = line.match(/^ARG\s+KIRO2CLAUDE_CLI_VERSION\b(.*)$/);
      if (m) {
        topLevelArg = m[1].trim();
        break;
      }
    }
    if (topLevelArg === undefined) {
      throw new Error(
        `Dockerfile 顶部找不到 \`ARG KIRO2CLAUDE_CLI_VERSION\` 声明 —— 单一真相源架构要求这个 ARG 存在但无默认值。`,
      );
    }
    if (topLevelArg !== '' && !topLevelArg.startsWith('#')) {
      const display = topLevelArg ? ` ${topLevelArg}` : '';
      throw new Error(
        `Dockerfile 的 \`ARG KIRO2CLAUDE_CLI_VERSION${display}\` 不应有默认值。\n` +
          `单一真相源架构要求 build 时由 \`pnpm docker:build\` wrapper 从 fixture 派生版本号。\n` +
          `恢复方式：把这一行改回 \`ARG KIRO2CLAUDE_CLI_VERSION\` 并删除等号后的值。`,
      );
    }
  });

  it("FALLBACK_PROFILE.kiroCliVersion is fixed to 'unknown' (sentinel, not a version copy)", () => {
    const source = fs.readFileSync(CLIENT_PROFILE_TS, 'utf-8');
    const fallbackStart = source.indexOf('const FALLBACK_PROFILE');
    if (fallbackStart === -1) {
      throw new Error(`src/kiro/client-profile.ts 中找不到 \`const FALLBACK_PROFILE\` 声明`);
    }
    const slice = source.slice(fallbackStart, fallbackStart + 2000);
    const m = slice.match(/kiroCliVersion\s*:\s*['"]([^'"]+)['"]/);
    if (!m) {
      throw new Error(
        `src/kiro/client-profile.ts 的 FALLBACK_PROFILE 块里找不到 \`kiroCliVersion: '<X>'\``,
      );
    }
    if (m[1] !== 'unknown') {
      throw new Error(
        `FALLBACK_PROFILE.kiroCliVersion 应当固定为 'unknown'，实际是 '${m[1]}'。\n` +
          `单一真相源架构下 FALLBACK 不再作为版本号副本——它是 fixture 缺失时的兜底快照，\n` +
          `kiroCliVersion 字段应显式 mark 为 'unknown' 而不是某个具体版本（否则会过期且误导）。`,
      );
    }
  });
});
