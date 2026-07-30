/**
 * shared/paths 单测
 *
 * `findUpwards` 用 tmpdir 里真造的目录树测——它的全部语义就是「在真实文件系统上
 * 往上走」，mock fs 只会测到 mock 自己。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { expandTilde, findUpwards } from '../../src/shared/paths.js';

describe('expandTilde', () => {
  it('展开独立的 ~ 和 ~/ 前缀，其余原样返回', () => {
    expect(expandTilde('~')).toBe(os.homedir());
    expect(expandTilde('~/a/b')).toBe(path.join(os.homedir(), 'a/b'));
    expect(expandTilde('/abs/path')).toBe('/abs/path');
    expect(expandTilde('relative')).toBe('relative');
    // ~user 不展开——Node 没有现成 API，所有用例都是当前用户
    expect(expandTilde('~other/x')).toBe('~other/x');
  });
});

describe('findUpwards', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'k2c-findup-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** 造 `<root>/<rel>` 目录并返回绝对路径 */
  function mkdir(rel: string): string {
    const p = path.join(root, rel);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  it('命中时同时给出祖先目录和完整路径', () => {
    mkdir('scripts');
    fs.writeFileSync(path.join(root, 'scripts', 'x.sh'), '');
    const from = mkdir('packages/core/dist/kiro');

    const { hit } = findUpwards(from, path.join('scripts', 'x.sh'));

    expect(hit?.dir).toBe(root);
    expect(hit?.path).toBe(path.join(root, 'scripts', 'x.sh'));
  });

  it('先探起始目录自身，再逐级向上', () => {
    const from = mkdir('a/b/c');
    fs.mkdirSync(path.join(from, 'node_modules'));

    const { hit, probed } = findUpwards(from, 'node_modules');

    expect(hit?.dir).toBe(from);
    expect(probed).toEqual([path.join(from, 'node_modules')]);
  });

  it('取最近的那个祖先，不是最远的', () => {
    fs.mkdirSync(path.join(root, 'node_modules'));
    const mid = mkdir('a/b');
    fs.mkdirSync(path.join(mid, 'node_modules'));
    const from = mkdir('a/b/c/d');

    expect(findUpwards(from, 'node_modules').hit?.dir).toBe(mid);
  });

  it('找不到时 hit 为 undefined，probed 记下走过的每一层', () => {
    const from = mkdir('a/b');

    const { hit, probed } = findUpwards(from, 'definitely-not-here.txt');

    expect(hit).toBeUndefined();
    // 走到文件系统根为止，所以至少覆盖 from 及其两级祖先
    expect(probed[0]).toBe(path.join(from, 'definitely-not-here.txt'));
    expect(probed).toContain(path.join(root, 'definitely-not-here.txt'));
    expect(probed.length).toBeGreaterThan(2);
  });

  it('走到文件系统根即终止，不死循环', () => {
    const from = mkdir('a');
    const { probed } = findUpwards(from, 'definitely-not-here.txt');

    // 最后一个候选必然挂在文件系统根上
    const last = probed[probed.length - 1] as string;
    expect(path.dirname(last)).toBe(path.parse(from).root);
  });

  it('target 是目录也算命中（node_modules 这类 marker 语义）', () => {
    const from = mkdir('a/b');
    fs.mkdirSync(path.join(root, 'a', 'node_modules'));

    expect(findUpwards(from, 'node_modules').hit?.dir).toBe(path.join(root, 'a'));
  });
});
