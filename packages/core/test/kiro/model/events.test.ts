import { describe, expect, it } from 'vitest';
import { eventFromFrame } from '../../../src/kiro/model/events/base.js';
import { EventStreamDecoder } from '../../../src/kiro/parser/decoder.js';
import { encodeEventStreamFrame } from '../../helpers/event-stream.js';

function parse(eventType: string, payload: unknown) {
  const decoder = new EventStreamDecoder();
  decoder.feed(
    encodeEventStreamFrame(
      { ':event-type': eventType },
      Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)),
    ),
  );
  const result = decoder.drainAll()[0];
  if (!result || !('frame' in result)) throw new Error('Test frame did not decode');
  return eventFromFrame(result.frame);
}

describe('known event wire fields', () => {
  it.each([
    ['assistantResponseEvent', 'content'],
    ['reasoningContentEvent', 'text'],
    ['reasoningContentEvent', 'signature'],
    ['reasoningContentEvent', 'redactedContent'],
    ['meteringEvent', 'unit'],
    ['meteringEvent', 'unitPlural'],
    ['meteringEvent', 'usage'],
    ['contextUsageEvent', 'contextUsagePercentage'],
    ['metadataEvent', 'stopReason'],
  ])('%s rejects populated %s with the wrong type', (eventType, field) => {
    expect(() => parse(eventType, { [field]: {} })).toThrow('Invalid event field');
  });

  it.each([
    ['meteringEvent', 'usage'],
    ['contextUsageEvent', 'contextUsagePercentage'],
  ])('%s rejects nonfinite %s represented by valid JSON', (eventType, field) => {
    expect(() => parse(eventType, Buffer.from(`{"${field}":1e400}`))).toThrow('finite number');
  });

  it('absent and previously nullable fields retain their defaults', () => {
    for (const payload of [{}, { content: null }]) {
      expect(parse('assistantResponseEvent', payload)).toEqual({
        kind: 'AssistantResponse',
        content: '',
      });
    }
    expect(
      parse('reasoningContentEvent', { text: null, signature: null, redactedContent: null }),
    ).toEqual({
      kind: 'ReasoningContent',
      text: '',
      signature: undefined,
      redactedContent: undefined,
    });
    expect(
      parse('meteringEvent', { usage: null, unit: null, unitPlural: null, future: { value: 1 } }),
    ).toEqual({ kind: 'Metering', usage: 0, unit: '', unitPlural: '', future: { value: 1 } });
    expect(parse('contextUsageEvent', { contextUsagePercentage: null })).toEqual({
      kind: 'ContextUsage',
      contextUsagePercentage: 0,
    });
  });

  it('metadataEvent is a known completion marker, never an Unknown event', () => {
    // 351/352 audited real responses end with it; `stopReason` is kept for
    // diagnostics only (it reads END_TURN even when tools were called).
    expect(parse('metadataEvent', { stopReason: 'END_TURN' })).toEqual({
      kind: 'Metadata',
      stopReason: 'END_TURN',
    });
    for (const payload of [{}, { stopReason: null }]) {
      expect(parse('metadataEvent', payload)).toEqual({ kind: 'Metadata', stopReason: undefined });
    }
  });

  it('unknown events retain opaque non-JSON bytes', () => {
    const payload = Buffer.from([0xff, 0x00, 0x7b]);
    expect(parse('futureEvent', payload)).toEqual({
      kind: 'Unknown',
      eventType: 'futureEvent',
      payload,
    });
  });
});
