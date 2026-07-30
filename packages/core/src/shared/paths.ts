/**
 * 与文件路径相关的共享工具。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 展开路径前缀的 `~` 到 `$HOME`。
 *
 * 只处理两种形态：独立的 `~` 和 `~/` 开头的路径。不做更复杂的
 * `~user` 展开——Node 里没有现成 API，我们的所有用例都是当前用户。
 */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface FindUpwardsHit {
  /** 命中的祖先目录本身（`node_modules` 这类 marker 语义要这个） */
  dir: string;
  /** 命中的完整路径（命名资源语义要这个） */
  path: string;
}

export interface FindUpwardsResult {
  hit?: FindUpwardsHit;
  /** 按顺序探过的候选，找不到时进日志——缺了它，解析失败会被当成环境问题 */
  probed: string[];
}

/**
 * 从 `from` 起逐级向上找第一个满足 `<祖先>/<target>` 存在的祖先，含 `from` 自身，
 * 到文件系统根即止。
 *
 * 不能写死层数：`scripts/` `fixtures/` `node_modules/` 都固定在仓库根或镜像根，
 * 但调用模块到那个根的距离随布局变化——镜像 `/app/dist/kiro/` 是 2 级，monorepo
 * `packages/core/{src,dist}/kiro/` 是 4 级。固定 `'..','..'` 只满足一种，另一种
 * 静默失败（`auto-capture` 就这么潜伏过）。
 */
export function findUpwards(from: string, target: string): FindUpwardsResult {
  const probed: string[] = [];
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, target);
    probed.push(candidate);
    if (fs.existsSync(candidate)) return { hit: { dir, path: candidate }, probed };
    const parent = path.dirname(dir);
    if (parent === dir) return { probed };
    dir = parent;
  }
}
