import { describe, expect, it } from 'vitest';
import { ParseException } from '../../../src/kiro/parser/error.js';
import {
  Headers,
  type HeaderValue,
  HeaderValueType,
  headerValueAsStr,
  parseHeaders,
} from '../../../src/kiro/parser/header.js';

describe('header parser', () => {
  it('test_header_value_type_conversion', () => {
    // Valid values: parseHeaders triggers conversion internally via a byte, but we test the enum range
    expect(HeaderValueType.BoolTrue).toBe(0);
    expect(HeaderValueType.String).toBe(7);

    // Invalid header type should throw when parseHeaders encounters it
    // Construct: name_len(1) + name("x") + type(10 = invalid)
    const data = Buffer.from([1, 0x78, 10]);
    expect(() => parseHeaders(data, data.length)).toThrow(ParseException);
  });

  it('test_header_value_as_str', () => {
    const stringVal: HeaderValue = { kind: 'String', value: 'test' };
    expect(headerValueAsStr(stringVal)).toBe('test');

    const boolVal: HeaderValue = { kind: 'Bool', value: true };
    expect(headerValueAsStr(boolVal)).toBeUndefined();
  });

  it('test_headers_get_string', () => {
    const headers = new Headers();
    headers.insert(':message-type', { kind: 'String', value: 'event' });
    expect(headers.messageType()).toBe('event');
  });

  it('test_parse_headers_string', () => {
    // name_len(1) + name "x" + type(7=String) + value_len(2) + value "ab"
    const data = Buffer.from([1, 0x78, 7, 0, 2, 0x61, 0x62]);
    const headers = parseHeaders(data, data.length);
    expect(headers.getString('x')).toBe('ab');
  });
});
