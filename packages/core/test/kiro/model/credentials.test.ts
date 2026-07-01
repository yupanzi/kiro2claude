import { describe, expect, it } from 'vitest';
import {
  credentialEffectiveApiRegion,
  credentialEffectiveAuthRegion,
  type KiroCredentials,
} from '../../../src/kiro/model/credentials.js';
import type { Config } from '../../../src/model/config.js';

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 8080,
    region: 'us-east-1',
    apiKey: 'test',
    countTokensAuthType: 'x-api-key',
    extractThinking: true,
    autoCaptureProfile: false,
    loginLicense: 'pro',
    loginTimeoutMs: 300_000,
    ...overrides,
  };
}

describe('credentialEffectiveAuthRegion', () => {
  it('uses credential authRegion when set', () => {
    const cred: KiroCredentials = { authRegion: 'eu-west-1', region: 'us-east-1' };
    const config = buildConfig({ region: 'ap-northeast-1' });
    expect(credentialEffectiveAuthRegion(cred, config)).toBe('eu-west-1');
  });

  it('falls back to credential region when authRegion missing', () => {
    const cred: KiroCredentials = { region: 'eu-west-1' };
    const config = buildConfig({ region: 'us-east-1' });
    expect(credentialEffectiveAuthRegion(cred, config)).toBe('eu-west-1');
  });

  it('falls back to config authRegion when credential has neither', () => {
    const cred: KiroCredentials = {};
    const config = buildConfig({ region: 'us-east-1', authRegion: 'eu-central-1' });
    expect(credentialEffectiveAuthRegion(cred, config)).toBe('eu-central-1');
  });

  it('falls back to config region as last resort', () => {
    const cred: KiroCredentials = {};
    const config = buildConfig({ region: 'ap-northeast-1' });
    expect(credentialEffectiveAuthRegion(cred, config)).toBe('ap-northeast-1');
  });
});

describe('credentialEffectiveApiRegion', () => {
  it('uses credential apiRegion when set', () => {
    const cred: KiroCredentials = { apiRegion: 'us-west-2' };
    const config = buildConfig({ region: 'us-east-1' });
    expect(credentialEffectiveApiRegion(cred, config)).toBe('us-west-2');
  });

  it('does NOT fall back to credential region (by design)', () => {
    // credentialEffectiveApiRegion is tighter than credentialEffectiveAuthRegion:
    // it only uses cred.apiRegion, not cred.region, so that users can scope
    // Token refresh vs API requests to different regions independently.
    const cred: KiroCredentials = { region: 'us-west-2' };
    const config = buildConfig({ region: 'us-east-1' });
    expect(credentialEffectiveApiRegion(cred, config)).toBe('us-east-1');
  });

  it('falls back to config apiRegion when set', () => {
    const cred: KiroCredentials = {};
    const config = buildConfig({ region: 'us-east-1', apiRegion: 'eu-west-1' });
    expect(credentialEffectiveApiRegion(cred, config)).toBe('eu-west-1');
  });

  it('falls back to config region as last resort', () => {
    const cred: KiroCredentials = {};
    const config = buildConfig({ region: 'ap-northeast-1' });
    expect(credentialEffectiveApiRegion(cred, config)).toBe('ap-northeast-1');
  });
});
