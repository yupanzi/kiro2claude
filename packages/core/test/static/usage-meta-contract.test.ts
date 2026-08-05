/**
 * 静态守卫:`kiro.*` meta 键的实现与它的**两份**文档必须一致。
 *
 * 这批键是插件的公开契约,却被抄在三处:实现在 `claude/stream.ts` 的
 * `buildKiroUsageFinishEvent`,文档在 `@kiro2claude/plugin-api` 的 `getMeta`
 * 头注释(插件作者写代码时看的)和 `docs/PLUGIN-DEVELOPMENT.md` 的表(插件作者
 * 上手时看的)。三份没有任何机制绑定,于是全都漂过:
 *
 *   - `kiro.cacheReadTokens` / `kiro.cacheCreationTokens` 在两份文档里躺了很久,
 *     实现**从未产出**过 —— 照着写的插件只会拿到 undefined,而 undefined 在这套
 *     契约里的含义是「本次不可用」,不是「永远不存在」,所以连报错都不会有;
 *   - 反向漂移同时存在:`kiro.upstreamRaw` 只写在 md 里、没写进 types.ts,
 *     新增的 `kiro.meteringMissing` 两边都没有,而内置 plugin 已经在读它。
 *
 * 计量键漏一个的代价是记账系统性偏低且无人察觉(见 `isMeteringLost`),所以这里
 * 用源码文本比对钉死三方。手法同 `freeform-tool-contract.test.ts` /
 * `log-capacity-reason.test.ts`:读源码而非跑代码,新增键时**必须**同步两份文档,
 * 否则红。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

const STREAM_SRC = readFileSync(join(REPO, 'packages/core/src/claude/stream.ts'), 'utf8');
const PLUGIN_API_SRC = readFileSync(join(REPO, 'packages/plugin-api/src/types.ts'), 'utf8');
const PLUGIN_DOC = readFileSync(join(REPO, 'docs/PLUGIN-DEVELOPMENT.md'), 'utf8');

/** 实现真相源:`buildKiroUsageFinishEvent` 的 meta 对象字面量里写了哪些键。 */
function implementedKeys(): string[] {
  const fn = STREAM_SRC.indexOf('export function buildKiroUsageFinishEvent');
  expect(fn).toBeGreaterThan(-1);
  // 直接锚 `meta: {` 块,不靠「函数体结束」——签名里的 args 类型字面量本身就以
  // `}): UsageFinishEventImpl {` 收尾,按 `\n}` 找会在 meta 块**之前**截断,
  // 于是扫出空集、三方比对全绿而实际毫无约束(本守卫初版就踩了这个坑)。
  const start = STREAM_SRC.indexOf('meta: {', fn);
  expect(start).toBeGreaterThan(fn);
  const end = STREAM_SRC.indexOf('\n    },', start);
  expect(end).toBeGreaterThan(start);
  const body = STREAM_SRC.slice(start, end);
  const keys = [...body.matchAll(/'(kiro\.[A-Za-z]+)':/g)].map((m) => m[1]).sort();
  // 抽取失败必须红,不能退化成「两边都是空集所以一致」。
  expect(keys.length).toBeGreaterThan(0);
  return keys;
}

/** plugin-api 的 getMeta 头注释里列了哪些键。 */
function pluginApiDocumentedKeys(): string[] {
  const start = PLUGIN_API_SRC.indexOf('Well-known keys');
  expect(start).toBeGreaterThan(-1);
  const end = PLUGIN_API_SRC.indexOf('getMeta<T = unknown>', start);
  expect(end).toBeGreaterThan(start);
  const block = PLUGIN_API_SRC.slice(start, end);
  return [...new Set([...block.matchAll(/'(kiro\.[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
}

/** PLUGIN-DEVELOPMENT.md 的 Meta 键表格里列了哪些键。 */
function markdownDocumentedKeys(): string[] {
  const start = PLUGIN_DOC.indexOf('### Meta 键');
  expect(start).toBeGreaterThan(-1);
  const end = PLUGIN_DOC.indexOf('### Wire 改写', start);
  expect(end).toBeGreaterThan(start);
  const section = PLUGIN_DOC.slice(start, end);
  // 只取表格行(以 `| \`kiro.` 开头),正文里的行内引用不算声明。
  return [...new Set([...section.matchAll(/^\|\s*`(kiro\.[A-Za-z]+)`/gm)].map((m) => m[1]))].sort();
}

describe('kiro.* usage meta 契约', () => {
  it('实现至少产出了这些键(变更时本行是有意的破坏点)', () => {
    // 显式清单而非只做三方比对:三份同时被改错时比对仍然全绿,这一行不会。
    expect(implementedKeys()).toEqual([
      'kiro.creditsUsed',
      'kiro.inputTokens',
      'kiro.meteringMissing',
      'kiro.outputTokens',
      'kiro.pricedModel',
      'kiro.upstreamRaw',
    ]);
  });

  it('plugin-api 头注释与实现逐键一致', () => {
    // 多列 = 插件作者照着写却永远拿 undefined;少列 = 新能力无人发现。
    expect(pluginApiDocumentedKeys()).toEqual(implementedKeys());
  });

  it('PLUGIN-DEVELOPMENT.md 表格与实现逐键一致', () => {
    expect(markdownDocumentedKeys()).toEqual(implementedKeys());
  });

  it('两份文档都讲清了「有键 ≠ 有值」', () => {
    // 曾写成「缺失的键应视为该特性不可用」——而 listMetaKeys() 返回
    // Object.keys(meta),约定键**恒在**,该判据恒为假。照它写的可用性检查全是死代码。
    expect(PLUGIN_API_SRC).toContain('listMetaKeys().includes(k)');
    expect(PLUGIN_DOC).toContain('listMetaKeys().includes(k)');
  });
});
