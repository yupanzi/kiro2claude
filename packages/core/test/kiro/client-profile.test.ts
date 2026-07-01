import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetKiroClientProfileCacheForTesting,
  getKiroClientProfile,
  renderUserAgent,
  renderXAmzUserAgent,
  requireAmzTarget,
} from '../../src/kiro/client-profile.js';

/**
 * client-profile 模块的职责是「加载并缓存捕获脚本产出的 kiro-cli 请求画像」。
 * 测试要覆盖：
 *   1. 默认 fallback 路径下的返回值（没 fixture 也能跑）
 *   2. `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 环境变量可以指向一个自定义 JSON
 *   3. UA 模板里的 `{service}` 占位能被正确替换
 *   4. 缓存语义：同一进程首次加载后后续读缓存
 */

describe('getKiroClientProfile', () => {
  const originalEnv = process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;

  beforeEach(() => {
    _resetKiroClientProfileCacheForTesting();
    delete process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;
  });

  afterEach(() => {
    _resetKiroClientProfileCacheForTesting();
    if (originalEnv === undefined) {
      delete process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;
    } else {
      process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = originalEnv;
    }
  });

  it('returns a profile with kiro-cli aligned defaults', () => {
    const profile = getKiroClientProfile();

    // mode 是 discriminator，保证后续分支代码拿得到类型收窄
    expect(profile.mode).toBe('kiro-cli');

    // 断言 body 里的语义字段完全对齐 kiro-cli 2.0+ 实测结果
    expect(profile.body.origin).toBe('KIRO_CLI');
    expect(profile.body.agentTaskType).toBe('vibe');
    expect(profile.body.chatTriggerType).toBe('MANUAL');
    // envState.operatingSystem 在 profile 层保持 `{os}` 占位，runtime 才会
    // 按 process.platform 替换成 macos/linux —— 这是跨平台部署的核心设计。
    expect(profile.body.envState.operatingSystem).toBe('{os}');

    // 静态头部必须至少包含 content-type 和 optout 开关
    expect(profile.staticHeaders['content-type']).toBe('application/x-amz-json-1.0');
    expect(profile.staticHeaders['x-amzn-codewhisperer-optout']).toBeDefined();

    // x-amz-target 映射是 kiro-cli 的 Smithy 协议关键字段
    expect(profile.amzTargets.generateAssistantResponse).toBe(
      'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
    );
    expect(profile.amzTargets.getUsageLimits).toBe('AmazonCodeWhispererService.GetUsageLimits');
  });

  it('renderUserAgent replaces both {service} and {os} placeholders', () => {
    const profile = getKiroClientProfile();
    const streaming = renderUserAgent(profile, 'codewhispererstreaming');
    const runtime = renderUserAgent(profile, 'codewhispererruntime');

    expect(streaming).toContain('api/codewhispererstreaming/');
    expect(streaming).not.toContain('{service}');
    expect(streaming).not.toContain('{os}');
    expect(runtime).toContain('api/codewhispererruntime/');
    expect(runtime).not.toContain('{os}');

    // os token 必须落到当前平台的 kiro-cli 风格字符串之一
    expect(streaming).toMatch(/\bos\/(macos|linux|windows)\b/);

    // x-amz-user-agent 有自己单独的模板，同样应该 render 成功
    const xAmzUa = renderXAmzUserAgent(profile, 'codewhispererstreaming');
    expect(xAmzUa).toContain('api/codewhispererstreaming/');
    expect(xAmzUa).not.toContain('{service}');
    expect(xAmzUa).not.toContain('{os}');
    expect(xAmzUa).toMatch(/\bos\/(macos|linux|windows)\b/);
  });

  it('picks the os token that matches process.platform', () => {
    // 根据运行测试的平台，renderUserAgent 里的 `os/{os}` 应该被替换成
    // 对应的 kiro-cli 字符串：darwin→macos, linux→linux, win32→windows。
    const profile = getKiroClientProfile();
    const ua = renderUserAgent(profile, 'codewhispererstreaming');
    const expected =
      process.platform === 'darwin'
        ? 'os/macos'
        : process.platform === 'linux'
          ? 'os/linux'
          : process.platform === 'win32'
            ? 'os/windows'
            : 'os/linux'; // 冷门平台 fallback
    expect(ua).toContain(expected);
  });

  it('requireAmzTarget returns the value when present', () => {
    const profile = getKiroClientProfile();
    const target = requireAmzTarget(profile, 'generateAssistantResponse');
    expect(target).toBe('AmazonCodeWhispererStreamingService.GenerateAssistantResponse');
  });

  it('loads a profile from a path supplied via KIRO2CLAUDE_CLIENT_PROFILE_PATH', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-cli-profile-test-'));
    const fixturePath = path.join(tmpDir, 'profile.json');
    try {
      const payload = {
        kiroCliVersion: 'test-9.9.9',
        staticHeaders: {
          'content-type': 'application/x-amz-json-1.0',
          'x-amzn-codewhisperer-optout': 'true',
        },
        userAgent: 'custom/1.0 api/{service}/x os/linux',
        xAmzUserAgent: 'custom/1.0 api/{service}/x m/X',
        amzTargets: {
          generateAssistantResponse: 'Custom.GenerateAssistantResponse',
          getUsageLimits: 'Custom.GetUsageLimits',
        },
        body: {
          origin: 'TEST_ORIGIN',
          agentTaskType: 'vibe',
          chatTriggerType: 'MANUAL',
          envState: { operatingSystem: 'linux' },
        },
      };
      fs.writeFileSync(fixturePath, JSON.stringify(payload));
      process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = fixturePath;

      const profile = getKiroClientProfile();
      expect(profile.kiroCliVersion).toBe('test-9.9.9');
      expect(profile.body.origin).toBe('TEST_ORIGIN');
      // Fixture 里 linux 被归一化成 `{os}`；render 时再按当前 process.platform 替换
      expect(profile.body.envState.operatingSystem).toBe('{os}');
      expect(profile.amzTargets.generateAssistantResponse).toBe('Custom.GenerateAssistantResponse');

      const ua = renderUserAgent(profile, 'codewhispererstreaming');
      // 在 darwin CI 上渲染成 `os/macos`，在 linux CI 上渲染成 `os/linux`；
      // 不 hardcode 具体值，只断言占位符被替换掉了。
      expect(ua).toMatch(/^custom\/1\.0 api\/codewhispererstreaming\/x os\/(macos|linux|windows)$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('caches the profile across calls', () => {
    const a = getKiroClientProfile();
    const b = getKiroClientProfile();
    expect(a).toBe(b);
  });
});
