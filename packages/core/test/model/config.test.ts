import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFromEnv } from '../../src/model/config.js';

/**
 * These tests mutate process.env. The beforeEach/afterEach pair restores the
 * original environment so tests are order-independent.
 */
describe('loadConfigFromEnv', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear every KIRO2CLAUDE_* variable so tests start from a clean slate
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KIRO2CLAUDE_')) delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when KIRO2CLAUDE_API_KEY is missing', () => {
    expect(() => loadConfigFromEnv()).toThrow(/KIRO2CLAUDE_API_KEY is required/);
  });

  it('throws when KIRO2CLAUDE_API_KEY is whitespace only', () => {
    process.env.KIRO2CLAUDE_API_KEY = '   ';
    expect(() => loadConfigFromEnv()).toThrow(/KIRO2CLAUDE_API_KEY is required/);
  });

  it('uses defaults when only KIRO2CLAUDE_API_KEY is set', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    const config = loadConfigFromEnv();
    expect(config.apiKey).toBe('sk-test');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8080);
    expect(config.region).toBe('us-east-1');
    expect(config.extractThinking).toBe(true);
    expect(config.autoCaptureProfile).toBe(false);
    expect(config.loginLicense).toBe('pro');
  });

  it('parses KIRO2CLAUDE_PORT as integer', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    process.env.KIRO2CLAUDE_PORT = '3000';
    const config = loadConfigFromEnv();
    expect(config.port).toBe(3000);
  });

  it('rejects non-numeric KIRO2CLAUDE_PORT', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    process.env.KIRO2CLAUDE_PORT = 'abc';
    expect(() => loadConfigFromEnv()).toThrow(/KIRO2CLAUDE_PORT must be an integer/);
  });

  it('rejects KIRO2CLAUDE_PORT out of range', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    process.env.KIRO2CLAUDE_PORT = '70000';
    expect(() => loadConfigFromEnv()).toThrow(/KIRO2CLAUDE_PORT out of range/);
  });

  it('parses KIRO2CLAUDE_EXTRACT_THINKING boolean variants', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    const cases: Array<[string, boolean]> = [
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['yes', true],
      ['no', false],
      ['on', true],
      ['off', false],
      ['TRUE', true],
      ['False', false],
    ];
    for (const [value, expected] of cases) {
      process.env.KIRO2CLAUDE_EXTRACT_THINKING = value;
      expect(loadConfigFromEnv().extractThinking).toBe(expected);
    }
  });

  it('throws on invalid KIRO2CLAUDE_EXTRACT_THINKING value', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    process.env.KIRO2CLAUDE_EXTRACT_THINKING = 'maybe';
    expect(() => loadConfigFromEnv()).toThrow(/Invalid boolean value/);
  });

  it('rejects invalid KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    process.env.KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE = 'basic';
    expect(() => loadConfigFromEnv()).toThrow(/KIRO2CLAUDE_COUNT_TOKENS_AUTH_TYPE must be/);
  });

  it('leaves authRegion / apiRegion undefined when not set (runtime falls back to region)', () => {
    process.env.KIRO2CLAUDE_API_KEY = 'sk-test';
    const config = loadConfigFromEnv();
    expect(config.authRegion).toBeUndefined();
    expect(config.apiRegion).toBeUndefined();
  });
});
