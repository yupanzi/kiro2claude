/**
 * Static guard: 向上走查定位资源的布局不变式
 *
 * `auto-capture.ts` / `client-profile.ts` / `index.ts` 都靠 `findUpwards()` 从
 * 自身位置向上找仓库根的资源。不变式横跨源码与 Dockerfile，任一处单独改动都不会
 * 被其它测试发现：
 *
 *   1. `scripts/capture-kiro-cli.sh` 在**仓库根**（走查终点）
 *   2. `docker/Dockerfile` 把 `scripts/` 复制进镜像——删掉那行 COPY，`test/static/`
 *      其余用例全绿，而镜像里 auto-capture 静默失效
 *   3. 三处都复用 `findUpwards()`，不各自手写循环或退回固定 `'..','..'`
 *
 * 老实现用固定层数，只在镜像布局成立，monorepo 下永远解析不到，而失败只 warn——
 * 缺的正是这条断言，所以能带着上线并被长期当成环境问题。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// test/static/ → packages/core/ → 仓库根
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');

const CAPTURE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'capture-kiro-cli.sh');
const DOCKERFILE = path.join(REPO_ROOT, 'docker', 'Dockerfile');

/** 三个走查调用点：相对 packages/core/src 的路径 */
const WALK_UP_CALLERS = ['kiro/auto-capture.ts', 'kiro/client-profile.ts', 'index.ts'];

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(PACKAGE_ROOT, 'src', rel), 'utf-8');
}

describe('static guard: 向上走查布局', () => {
  it('capture 脚本在仓库根（走查终点）', () => {
    expect(fs.existsSync(CAPTURE_SCRIPT)).toBe(true);
    expect(fs.statSync(CAPTURE_SCRIPT).isFile()).toBe(true);
  });

  it('capture 脚本不在 packages/core 下（否则固定层数版本会“碰巧”能跑，掩盖回归）', () => {
    expect(fs.existsSync(path.join(PACKAGE_ROOT, 'scripts', 'capture-kiro-cli.sh'))).toBe(false);
  });

  it('Dockerfile 把 scripts/ 复制进镜像', () => {
    // 允许 --chown 等 flag，但必须是 scripts → ./scripts 这一对
    expect(fs.readFileSync(DOCKERFILE, 'utf-8')).toMatch(
      /^COPY\s+(?:--\S+\s+)*scripts\s+\.\/scripts\s*$/m,
    );
  });

  it.each(WALK_UP_CALLERS)('%s 复用 findUpwards()，不自己手写走查', (rel) => {
    const src = readSrc(rel);
    expect(src).toContain('findUpwards');

    // 防回归到固定层数。`index.ts` 的 cwd 兜底（import.meta.url 不可用时）里
    // 那处 '..','..' 是合法的，它不是走查——按行排除掉。
    const fixedDepth = src
      .split('\n')
      .filter((l) => /'\.\.'\s*,\s*'\.\.'/.test(l) && !l.includes('cwd()'));
    expect(fixedDepth).toEqual([]);
  });

  it('findUpwards 无层数上限，靠文件系统根终止', () => {
    const src = readSrc('shared/paths.ts');
    expect(src).toMatch(/parent\s*===\s*dir/);
    expect(src).not.toMatch(/maxDepth|MAX_DEPTH/);
  });
});
