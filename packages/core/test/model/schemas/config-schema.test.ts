import { describe, expect, it } from 'vitest';

import {
  envSchema,
  envToConfig,
  formatEnvError,
  type ParsedEnv,
} from '../../../src/model/schemas/config-schema.js';

// A minimal env that passes the schema — all required fields present,
// everything else at default. Every negative test in this file starts from
// this baseline and mutates a single field so failures are isolated.
const MINIMAL_ENV: Record<string, string | undefined> = {
  KIRO2CLAUDE_API_KEY: 'sk-test-minimal',
};

describe('envSchema - happy paths', () => {
  it('accepts a minimal env with just KIRO2CLAUDE_API_KEY', () => {
    const result = envSchema.safeParse(MINIMAL_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_API_KEY).toBe('sk-test-minimal');
      expect(result.data.KIRO2CLAUDE_HOST).toBe('127.0.0.1');
      expect(result.data.KIRO2CLAUDE_PORT).toBe(8080);
      expect(result.data.KIRO2CLAUDE_REGION).toBe('us-east-1');
      expect(result.data.KIRO2CLAUDE_EXTRACT_THINKING).toBe(true);
      // KIRO2CLAUDE_DERIVED_INCLUDE_FIELD lives in the enterprise `derived` plugin, not core schema
      expect(result.data.KIRO2CLAUDE_AUTO_CAPTURE_PROFILE).toBe(false);
      expect(result.data.KIRO2CLAUDE_LOGIN_LICENSE).toBe('pro');
      expect(result.data.KIRO2CLAUDE_LOGIN_TIMEOUT_MS).toBe(600_000);
      expect(result.data.KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE).toBe('x-api-key');
    }
  });

  it('accepts a full env with every optional field set', () => {
    const result = envSchema.safeParse({
      KIRO2CLAUDE_HOST: '0.0.0.0',
      KIRO2CLAUDE_PORT: '9090',
      KIRO2CLAUDE_REGION: 'eu-west-1',
      KIRO2CLAUDE_AUTH_REGION: 'us-east-1',
      KIRO2CLAUDE_API_REGION: 'us-east-1',
      KIRO2CLAUDE_API_KEY: 'sk-test-full',
      KIRO2CLAUDE_COUNT_TOKENS_API_URL: 'https://count.example.com',
      KIRO2CLAUDE_COUNT_TOKENS_API_KEY: 'count-key',
      KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE: 'bearer',
      KIRO2CLAUDE_SQLITE_DB_PATH: '/tmp/test.sqlite',
      KIRO2CLAUDE_EXTRACT_THINKING: 'false',
      KIRO2CLAUDE_AUTO_CAPTURE_PROFILE: 'true',
      KIRO2CLAUDE_CLI_BIN: '/opt/kiro-cli',
      KIRO2CLAUDE_LOGIN_START_URL: 'https://sso.awsapps.com/start',
      KIRO2CLAUDE_LOGIN_REGION: 'us-east-1',
      KIRO2CLAUDE_LOGIN_LICENSE: 'free',
      KIRO2CLAUDE_LOGIN_TIMEOUT_MS: '600000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_PORT).toBe(9090);
      expect(result.data.KIRO2CLAUDE_EXTRACT_THINKING).toBe(false);
      expect(result.data.KIRO2CLAUDE_AUTO_CAPTURE_PROFILE).toBe(true);
      expect(result.data.KIRO2CLAUDE_LOGIN_TIMEOUT_MS).toBe(600_000);
    }
  });
});

describe('envSchema - KIRO2CLAUDE_EMPTY_STREAM_RETRIES', () => {
  it('defaults to 2 and maps to config.emptyStreamRetries', () => {
    const result = envSchema.safeParse(MINIMAL_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_EMPTY_STREAM_RETRIES).toBe(2);
      expect(envToConfig(result.data).emptyStreamRetries).toBe(2);
    }
  });

  it('accepts 0 (disable retries)', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EMPTY_STREAM_RETRIES: '0' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.KIRO2CLAUDE_EMPTY_STREAM_RETRIES).toBe(0);
  });

  it('accepts the upper bound 5', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EMPTY_STREAM_RETRIES: '5' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.KIRO2CLAUDE_EMPTY_STREAM_RETRIES).toBe(5);
  });

  it('rejects out-of-range values', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EMPTY_STREAM_RETRIES: '6' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_EMPTY_STREAM_RETRIES out of range/);
    }
  });
});

describe('envSchema - KIRO2CLAUDE_CAPTURE_EMPTY_DIR', () => {
  it('defaults to undefined (capture off)', () => {
    const result = envSchema.safeParse(MINIMAL_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_CAPTURE_EMPTY_DIR).toBeUndefined();
      expect(envToConfig(result.data).captureEmptyDir).toBeUndefined();
    }
  });

  it('maps a set directory through to config', () => {
    const result = envSchema.safeParse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_CAPTURE_EMPTY_DIR: '/var/log/k2c-empty',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(envToConfig(result.data).captureEmptyDir).toBe('/var/log/k2c-empty');
    }
  });
});

describe('envSchema - KIRO2CLAUDE_API_KEY required', () => {
  it('rejects missing KIRO2CLAUDE_API_KEY', () => {
    const result = envSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_API_KEY is required/);
    }
  });

  it('rejects empty KIRO2CLAUDE_API_KEY', () => {
    const result = envSchema.safeParse({ KIRO2CLAUDE_API_KEY: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_API_KEY is required/);
    }
  });

  it('rejects whitespace-only KIRO2CLAUDE_API_KEY', () => {
    const result = envSchema.safeParse({ KIRO2CLAUDE_API_KEY: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_API_KEY is required/);
    }
  });
});

describe('envSchema - KIRO2CLAUDE_PORT parsing', () => {
  it('rejects non-integer KIRO2CLAUDE_PORT', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_PORT must be an integer/);
    }
  });

  it('rejects KIRO2CLAUDE_PORT with trailing garbage', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: '80abc' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_PORT must be an integer/);
    }
  });

  it('rejects KIRO2CLAUDE_PORT above 65535', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: '99999' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_PORT out of range/);
    }
  });

  it('rejects KIRO2CLAUDE_PORT = 0', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/KIRO2CLAUDE_PORT out of range/);
    }
  });

  it('accepts boundary values 1 and 65535', () => {
    const low = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: '1' });
    expect(low.success).toBe(true);
    const high = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_PORT: '65535' });
    expect(high.success).toBe(true);
  });
});

describe('envSchema - boolean fields', () => {
  it('accepts all falsy aliases for KIRO2CLAUDE_EXTRACT_THINKING', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'No']) {
      const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EXTRACT_THINKING: v });
      expect(result.success, `value "${v}"`).toBe(true);
      if (result.success) {
        expect(result.data.KIRO2CLAUDE_EXTRACT_THINKING).toBe(false);
      }
    }
  });

  it('accepts all truthy aliases for KIRO2CLAUDE_EXTRACT_THINKING', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes']) {
      const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EXTRACT_THINKING: v });
      expect(result.success, `value "${v}"`).toBe(true);
      if (result.success) {
        expect(result.data.KIRO2CLAUDE_EXTRACT_THINKING).toBe(true);
      }
    }
  });

  it('rejects garbage boolean values', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_EXTRACT_THINKING: 'maybe' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/Invalid boolean value: maybe/);
    }
  });

  it('parses KIRO2CLAUDE_IDENTITY_OVERRIDE truthy aliases', () => {
    for (const v of ['1', 'true', 'yes', 'on']) {
      const result = envSchema.safeParse({
        ...MINIMAL_ENV,
        KIRO2CLAUDE_IDENTITY_OVERRIDE: v,
      });
      expect(result.success, `value "${v}"`).toBe(true);
      if (result.success) {
        expect(result.data.KIRO2CLAUDE_IDENTITY_OVERRIDE).toBe(true);
      }
    }
  });

  it('rejects garbage KIRO2CLAUDE_IDENTITY_OVERRIDE', () => {
    const result = envSchema.safeParse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_IDENTITY_OVERRIDE: 'sometimes',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(/Invalid boolean value: sometimes/);
    }
  });
});

describe('envSchema - KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE enum', () => {
  it('accepts x-api-key', () => {
    const result = envSchema.safeParse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE: 'x-api-key',
    });
    expect(result.success).toBe(true);
  });

  it('accepts bearer', () => {
    const result = envSchema.safeParse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE: 'bearer',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown auth types', () => {
    const result = envSchema.safeParse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE: 'oauth2',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatEnvError(result.error)).toMatch(
        /KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE must be 'x-api-key' or 'bearer'/,
      );
    }
  });
});

describe('envSchema - optional string normalization', () => {
  it('treats empty KIRO2CLAUDE_AUTH_REGION as undefined', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_AUTH_REGION: '' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_AUTH_REGION).toBeUndefined();
    }
  });

  it('preserves non-empty KIRO2CLAUDE_AUTH_REGION', () => {
    const result = envSchema.safeParse({ ...MINIMAL_ENV, KIRO2CLAUDE_AUTH_REGION: 'us-west-2' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KIRO2CLAUDE_AUTH_REGION).toBe('us-west-2');
    }
  });
});

describe('envToConfig', () => {
  it('maps parsed env to Config shape', () => {
    const parsed = envSchema.parse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_PORT: '8888',
      KIRO2CLAUDE_REGION: 'eu-central-1',
      KIRO2CLAUDE_AUTH_REGION: 'us-east-1',
      KIRO2CLAUDE_EXTRACT_THINKING: 'false',
    }) as ParsedEnv;

    const config = envToConfig(parsed);
    expect(config.apiKey).toBe('sk-test-minimal');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8888);
    expect(config.region).toBe('eu-central-1');
    expect(config.authRegion).toBe('us-east-1');
    expect(config.extractThinking).toBe(false);
    // identityOverride 未在此 env 显式设置 → 默认 true;与 extractThinking=false 取交叉值,
    // 「envToConfig 把 identityOverride 误映射成 KIRO2CLAUDE_EXTRACT_THINKING」会让此断言变红。
    expect(config.identityOverride).toBe(true);
    expect(config.countTokensAuthType).toBe('x-api-key');
    expect(config.loginLicense).toBe('pro');
    expect(config.loginTimeoutMs).toBe(600_000);
    // Removed after open-core split:
    //   meteringCounter / costMultiplier / includeKiroDerived are now read
    //   by their respective enterprise plugins from process.env directly,
    //   not surfaced through Config.
    expect('includeKiroDerived' in config).toBe(false);
    expect('meteringCounter' in config).toBe(false);
    expect('costMultiplier' in config).toBe(false);
  });

  it('maps KIRO2CLAUDE_IDENTITY_OVERRIDE to Config.identityOverride (cross-checked vs extractThinking)', () => {
    // 交叉值钉死 schema→Config 桥接没把两个 boolField 的 key 搞反:identityOverride 取 false、
    // extractThinking 取 true。互换映射(identityOverride: env.KIRO2CLAUDE_EXTRACT_THINKING)
    // 类型同为 boolean、能编译通过,但会让下面两条断言同时变红。
    const parsed = envSchema.parse({
      ...MINIMAL_ENV,
      KIRO2CLAUDE_IDENTITY_OVERRIDE: 'false',
      KIRO2CLAUDE_EXTRACT_THINKING: 'true',
    }) as ParsedEnv;
    const config = envToConfig(parsed);
    expect(config.identityOverride).toBe(false);
    expect(config.extractThinking).toBe(true);
  });

  it('does not leak removed env keys (open-core boundary)', () => {
    const parsed = envSchema.parse({
      ...MINIMAL_ENV,
    }) as ParsedEnv;
    // Plugin-owned envs must NOT be parsed by core schema (plugins read ctx.env).
    expect('KIRO2CLAUDE_DERIVED_INCLUDE_FIELD' in parsed).toBe(false);
    expect('KIRO2CLAUDE_METERING_DISABLE' in parsed).toBe(false);
    expect('KIRO2CLAUDE_COST_MULTIPLIER' in parsed).toBe(false);
  });
});
