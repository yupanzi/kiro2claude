/**
 * 静态守卫:freeform 替身编解码必须自洽。
 *
 * 「freeform = `{input: string}`」这条约定曾被抄在 4 个地方(schema / 历史包回 /
 * 流式解包 / 非流式解包),只靠注释「两端必须同形」绑定,两个解包点因此漂出了不同兜底。
 * 收敛到 `openai/freeform-tool.ts` 后,这里钉住 schema 声明的字段名与 wrap/unwrap
 * 实际读写的字段名一致——散开时它们会静默失配(工具照常上送、调用照常返回,只是
 * 载荷永远是空串)。同 `sse-backpressure-contract.test.ts` 的手法。
 */

import { describe, expect, it } from 'vitest';
import {
  FREEFORM_ADAPTATION_NOTE,
  FREEFORM_TOOL_SCHEMA,
  unwrapFreeformArgs,
  unwrapFreeformInput,
  wrapFreeformInput,
} from '../../src/openai/freeform-tool.js';

describe('freeform 替身 codec 契约', () => {
  const properties = FREEFORM_TOOL_SCHEMA.properties as Record<string, unknown>;
  const fieldNames = Object.keys(properties);

  it('schema 只声明一个字符串字段,且 required 与之一致', () => {
    expect(fieldNames).toHaveLength(1);
    expect(properties[fieldNames[0]]).toEqual({ type: 'string' });
    expect(FREEFORM_TOOL_SCHEMA.required).toEqual(fieldNames);
    expect(FREEFORM_TOOL_SCHEMA.additionalProperties).toBe(false);
  });

  it('wrap 写的字段就是 schema 声明的那个', () => {
    expect(Object.keys(wrapFreeformInput('x'))).toEqual(fieldNames);
  });

  it('wrap → unwrap 往返无损(这是编解码成对的核心)', () => {
    const text = 'await tools.apply_patch(`*** Begin Patch`);\ntext("ok");';
    expect(unwrapFreeformInput(wrapFreeformInput(text))).toBe(text);
    expect(unwrapFreeformArgs(JSON.stringify(wrapFreeformInput(text)))).toBe(text);
  });

  it('两个 unwrap 的兜底差异是刻意的,且各自被钉住', () => {
    // 非流式:reducer 在 JSON 解析失败时把 buffer 丢成 {},原文到不了这里 → 只能空串
    expect(unwrapFreeformInput({})).toBe('');
    expect(unwrapFreeformInput({ input: { nested: 1 } })).toBe('');
    expect(unwrapFreeformInput(undefined)).toBe('');
    // 流式:还留着原始累积串,模型吐裸文本时回退原文,不丢内容
    expect(unwrapFreeformArgs('raw text, not json')).toBe('raw text, not json');
    expect(unwrapFreeformArgs('')).toBe('');
  });

  it('合法的空输入解成空串,不回退原串', () => {
    // 回归守卫:曾用真值判断(`|| args`)导致 {"input":""} 回退成整个 wrapper JSON,
    // 客户端会把 `{"input":""}` 当工具的原始文本执行。判别必须看「字段在不在」。
    expect(unwrapFreeformArgs('{"input":""}')).toBe('');
    expect(unwrapFreeformInput({ input: '' })).toBe('');
    // 对照:字段真的缺失时才回退原串
    expect(unwrapFreeformArgs('{"other":1}')).toBe('{"other":1}');
    expect(unwrapFreeformArgs('{"input":null}')).toBe('{"input":null}');
  });

  it('适配说明提到 schema 的字段名(不然模型不知道往哪填)', () => {
    expect(FREEFORM_ADAPTATION_NOTE).toContain(`\`${fieldNames[0]}\``);
  });
});
