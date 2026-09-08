import { describe, expect, it } from 'vitest';
import { buildUpstreamAgentOptions, KiroProvider } from '../../src/kiro/provider.js';

describe('KiroProvider.isMonthlyRequestLimit', () => {
  it('test_is_monthly_request_limit_detects_reason', () => {
    const body = '{"message":"You have reached the limit.","reason":"MONTHLY_REQUEST_COUNT"}';
    expect(KiroProvider.isMonthlyRequestLimit(body)).toBe(true);
  });

  it('test_is_monthly_request_limit_nested_reason', () => {
    const body = '{"error":{"reason":"MONTHLY_REQUEST_COUNT"}}';
    expect(KiroProvider.isMonthlyRequestLimit(body)).toBe(true);
  });

  it('test_is_monthly_request_limit_false', () => {
    const body = '{"message":"nope","reason":"DAILY_REQUEST_COUNT"}';
    expect(KiroProvider.isMonthlyRequestLimit(body)).toBe(false);
  });
});

describe('KiroProvider.injectProfileArn', () => {
  it('test_inject_profile_arn_with_some', () => {
    const body = '{"conversationState":{"conversationId":"c1"}}';
    const arn = 'arn:aws:codewhisperer:us-east-1:123:profile/ABC';
    const result = KiroProvider.injectProfileArn(body, arn);
    const json = JSON.parse(result);
    expect(json.profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/ABC');
    expect(json.conversationState.conversationId).toBe('c1');
  });

  it('test_inject_profile_arn_with_none', () => {
    const body = '{"conversationState":{"conversationId":"c1"}}';
    const result = KiroProvider.injectProfileArn(body, undefined);
    const json = JSON.parse(result);
    expect(json.profileArn).toBeUndefined();
    expect(json.conversationState.conversationId).toBe('c1');
  });

  it('test_inject_profile_arn_overwrites_existing', () => {
    const body = '{"conversationState":{},"profileArn":"old-arn"}';
    const result = KiroProvider.injectProfileArn(body, 'new-arn');
    const json = JSON.parse(result);
    expect(json.profileArn).toBe('new-arn');
  });

  it('test_inject_profile_arn_invalid_json', () => {
    const body = 'not-valid-json';
    const result = KiroProvider.injectProfileArn(body, 'arn:test');
    // On parse failure, return as-is
    expect(result).toBe('not-valid-json');
  });
});

describe('buildUpstreamAgentOptions', () => {
  it('derives maxFreeSockets from maxSockets instead of a fixed smaller cap', () => {
    // 写死一个更小的 free 上限，高峰过后多出来的热连接会被关掉，下一波重做 TLS
    // 握手；Node 默认 256 同理会在大池子上隐式截断。两处都靠这条断言挡住。
    expect(buildUpstreamAgentOptions(100)).toEqual({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 100,
    });
    expect(buildUpstreamAgentOptions(1000).maxFreeSockets).toBe(1000);
  });
});
