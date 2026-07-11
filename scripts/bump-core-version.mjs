#!/usr/bin/env node
// bump-core-version.mjs —— 由 semantic-release 的 exec.prepareCmd 调用,把
// 本次发布算出的版本号写回 packages/core/package.json.version。
//
// 为什么单独一个脚本:core/package.json.version 是镜像 tag 的唯一真相源
// (release.yml 的 publishCmd + docker-build.sh 都从它派生 tag)。把写回
// 逻辑抽成文件而非塞进 .releaserc.json 的内联 `node -e`,避免 JSON 里
// 多层引号 / 反斜杠转义,且可单独执行 / 测试。
//
// 用法:node scripts/bump-core-version.mjs <version>
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: node scripts/bump-core-version.mjs <version>');
  process.exit(1);
}

const file = 'packages/core/package.json';
const pkg = JSON.parse(readFileSync(file, 'utf-8'));
pkg.version = version;
// 尾部换行 + 2 空格缩进;随后由 prepareCmd 的 `biome format` 归一化,
// 保证 release commit 的 JSON 能过后续 CI 的 biome check。
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`core package.json version → ${version}`);
