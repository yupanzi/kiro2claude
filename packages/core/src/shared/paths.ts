/**
 * 与文件路径相关的共享工具。
 */

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
