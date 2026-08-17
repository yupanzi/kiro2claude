import { describe, expect, it } from 'vitest';
import {
  LEGACY_THINKING_MAX_BUFFERED_CODE_UNITS,
  LEGACY_THINKING_MAX_LEADING_WHITESPACE,
  LegacyThinkingDecoder,
  type LegacyThinkingDecoderItem,
} from '../../src/claude/stream/legacy-thinking-decoder.js';

type SemanticResult = {
  sequence: Array<'thinking_start' | 'thinking' | 'thinking_end' | 'text'>;
  thinking: string;
  text: string;
  endReasons: string[];
};

function decode(
  chunks: string[],
  boundary: 'finish' | 'tool' = 'finish',
): LegacyThinkingDecoderItem[] {
  const decoder = new LegacyThinkingDecoder();
  const items = chunks.flatMap((chunk) => decoder.feed(chunk));
  items.push(...(boundary === 'finish' ? decoder.finish() : decoder.boundary('tool_boundary')));
  return items;
}

function semantics(items: LegacyThinkingDecoderItem[]): SemanticResult {
  const result: SemanticResult = {
    sequence: [],
    thinking: '',
    text: '',
    endReasons: [],
  };

  for (const item of items) {
    if (item.type === 'thinking' || item.type === 'text') {
      if (result.sequence.at(-1) !== item.type) result.sequence.push(item.type);
      result[item.type] += item.text;
    } else {
      result.sequence.push(item.type);
      if (item.type === 'thinking_end') result.endReasons.push(item.reason);
    }
  }
  return result;
}

function everyTwoWaySplit(input: string): string[][] {
  return Array.from({ length: input.length + 1 }, (_, index) => [
    input.slice(0, index),
    input.slice(index),
  ]);
}

function everyThreeWaySplit(input: string): string[][] {
  const splits: string[][] = [];
  for (let first = 0; first <= input.length; first++) {
    for (let second = first; second <= input.length; second++) {
      splits.push([input.slice(0, first), input.slice(first, second), input.slice(second)]);
    }
  }
  return splits;
}

describe('LegacyThinkingDecoder grammar', () => {
  it('decodes LF and CRLF framed thinking and strips one optional opening line ending', () => {
    expect(semantics(decode(['<thinking>\nReasoning.</thinking>\n\nVisible']))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end', 'text'],
      thinking: 'Reasoning.',
      text: 'Visible',
      endReasons: ['delimiter'],
    });
    expect(semantics(decode([' \t\r\n<thinking>\r\n理由。\r\n</thinking>\r\n\r\n答案']))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end', 'text'],
      thinking: '理由。\r\n',
      text: '答案',
      endReasons: ['delimiter'],
    });
  });

  it.each([
    '.',
    ',',
    '!',
    '?',
    ':',
    ';',
    ')',
    ']',
    '}',
    '-',
    '_',
    '=',
    '+',
    '。',
    '？',
    '…',
    '"',
    "'",
    '`',
    '🚀',
  ])('does not let preceding %s punctuation veto the close delimiter', (punctuation) => {
    const result = semantics(decode([`<thinking>thought${punctuation}</thinking>\n\nanswer`]));
    expect(result.thinking).toBe(`thought${punctuation}`);
    expect(result.text).toBe('answer');
    expect(result.endReasons).toEqual(['delimiter']);
  });

  it('only recognizes an opening tag at the start of a line', () => {
    // Inline mention — the model is talking about the tag, not opening a block.
    expect(semantics(decode(['prefix<thinking>x</thinking>\n\ny']))).toMatchObject({
      sequence: ['text'],
      thinking: '',
      text: 'prefix<thinking>x</thinking>\n\ny',
    });
    expect(semantics(decode(['`<thinking>`']))).toMatchObject({
      sequence: ['text'],
      thinking: '',
      text: '`<thinking>`',
    });

    // Only one block: after it closes, tag-shaped strings are ordinary text.
    expect(semantics(decode(['<thinking>x</thinking>\n\ny<thinking>z</thinking>\n\nw']))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end', 'text'],
      thinking: 'x',
      text: 'y<thinking>z</thinking>\n\nw',
      endReasons: ['delimiter'],
    });

    // Indentation before the tag is framing, not a text block.
    for (const indent of ['', ' ', '\t', ' '.repeat(LEGACY_THINKING_MAX_LEADING_WHITESPACE)]) {
      const result = semantics(decode([`${indent}<thinking>x</thinking>\n\ny`]));
      expect(result.thinking, JSON.stringify(indent)).toBe('x');
      expect(result.sequence[0], JSON.stringify(indent)).toBe('thinking_start');
    }
  });

  it('decodes a block that opens on a later line, keeping the preamble visible', () => {
    // ★ A preamble must not reclassify the chain of thought as visible text:
    // the rescue detector would then materialize an <invoke> the model only
    // drafted while thinking (phantom execution, see tool-call-text.ts).
    expect(semantics(decode(['Sure!\n<thinking>\ndrafting\n</thinking>\n\nDone.']))).toEqual({
      sequence: ['text', 'thinking_start', 'thinking', 'thinking_end', 'text'],
      thinking: 'drafting\n',
      text: 'Sure!\nDone.',
      endReasons: ['delimiter'],
    });

    // Indented on its own line still counts.
    expect(semantics(decode(['Intro.\n  <thinking>r</thinking>\n\nEnd'])).thinking).toBe('r');

    // But a tag that merely continues a line does not.
    expect(semantics(decode(['Intro. <thinking>r</thinking>\n\nEnd'])).thinking).toBe('');
  });

  it('treats a close tag without the exact separator as thinking content', () => {
    const input = '<thinking>a</thinking>\nb</thinking> x</thinking>\r\n\r\nvisible';
    expect(semantics(decode([input]))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end', 'text'],
      thinking: 'a</thinking>\nb</thinking> x',
      text: 'visible',
      endReasons: ['delimiter'],
    });
  });

  it('preserves plain input exactly when the prologue is not a complete opening tag', () => {
    for (const input of ['', '   ', '<', '<thinking', '\u00a0<thinking>x', '\rplain']) {
      const result = semantics(decode([input]));
      expect(result.thinking, input).toBe('');
      expect(result.text, input).toBe(input);
      expect(result.endReasons, input).toEqual([]);
    }
  });
});

describe('LegacyThinkingDecoder boundaries', () => {
  it.each([
    '',
    '\n',
    '\r',
    '\r\n',
    '\r\n\r',
  ])('accepts a complete tail close tag plus incomplete separator %j at EOF', (separator) => {
    expect(semantics(decode([`<thinking>body</thinking>${separator}`]))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end'],
      thinking: 'body',
      text: '',
      endReasons: ['delimiter'],
    });
  });

  it.each([
    '',
    '\n',
    '\r',
    '\r\n',
    '\r\n\r',
  ])('accepts a complete tail close tag plus incomplete separator %j at a tool boundary', (separator) => {
    expect(semantics(decode([`<thinking>body</thinking>${separator}`], 'tool'))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end'],
      thinking: 'body',
      text: '',
      endReasons: ['delimiter'],
    });
  });

  it('implicitly closes unclosed thinking before tools and at EOF without reclassifying it as text', () => {
    expect(semantics(decode(['<thinking>draft <invoke>unsafe'], 'tool'))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end'],
      thinking: 'draft <invoke>unsafe',
      text: '',
      endReasons: ['tool_boundary'],
    });
    expect(semantics(decode(['<thinking>unfinished']))).toEqual({
      sequence: ['thinking_start', 'thinking', 'thinking_end'],
      thinking: 'unfinished',
      text: '',
      endReasons: ['eof_unclosed'],
    });
  });

  it('accepts a close tag followed only by whitespace, so the tag never leaks into thinking', () => {
    // Trailing spaces are whitespace but not a `\n\n` prefix. Requiring the
    // exact separator here put the literal `</thinking>` inside the thinking
    // text, which converter.ts then re-wraps into history as a nested marker.
    for (const tail of ['  ', ' \t', '\n', '\r\n', '']) {
      const result = semantics(decode([`<thinking>body</thinking>${tail}`]));
      expect(result.thinking, JSON.stringify(tail)).toBe('body');
      expect(result.text, JSON.stringify(tail)).toBe('');
      expect(result.endReasons, JSON.stringify(tail)).toEqual(['delimiter']);
    }
  });

  it('still treats a close tag as content when non-whitespace follows', () => {
    const result = semantics(decode(['<thinking>body</thinking>  x</thinking>\n\nvisible']));
    expect(result.thinking).toBe('body</thinking>  x');
    expect(result.text).toBe('visible');
  });

  it('names the boundary that closed the block, so tools and native takeover stay distinct', () => {
    const takeover = new LegacyThinkingDecoder();
    takeover.feed('<thinking>draft');
    expect(semantics(takeover.boundary('native_takeover')).endReasons).toEqual(['native_takeover']);

    // An explicit close delimiter still wins over the caller's fallback.
    const closed = new LegacyThinkingDecoder();
    closed.feed('<thinking>done</thinking>');
    expect(semantics(closed.boundary('native_takeover')).endReasons).toEqual(['delimiter']);
  });

  it('resolves an opening CR correctly at a boundary', () => {
    expect(semantics(decode(['<thinking>\r']))).toMatchObject({
      thinking: '\r',
      endReasons: ['eof_unclosed'],
    });
    expect(semantics(decode(['<thinking>\r\n']))).toMatchObject({
      thinking: '',
      endReasons: ['eof_unclosed'],
    });
  });

  it('locks into text after a tool boundary before an opening tag is decided', () => {
    const decoder = new LegacyThinkingDecoder();
    const items = decoder.feed('  <think');
    items.push(...decoder.boundary('tool_boundary'));
    items.push(...decoder.feed('ing>not thinking'));
    items.push(...decoder.finish());
    expect(semantics(items)).toMatchObject({
      sequence: ['text'],
      thinking: '',
      text: '  <thinking>not thinking',
    });
  });

  it('makes finish idempotent and ignores later input and boundaries', () => {
    const decoder = new LegacyThinkingDecoder();
    const items = decoder.feed('<thinking>x');
    items.push(...decoder.finish());
    expect(items).toEqual([
      { type: 'thinking_start' },
      { type: 'thinking', text: 'x' },
      { type: 'thinking_end', reason: 'eof_unclosed' },
    ]);
    expect(decoder.finish()).toEqual([]);
    expect(decoder.feed('ignored')).toEqual([]);
    expect(decoder.boundary('tool_boundary')).toEqual([]);
  });
});

describe('LegacyThinkingDecoder chunk invariance and buffering', () => {
  it.each([
    '<thinking>Reasoning.</thinking>\n\nVisible answer',
    ' \r\n<thinking>理由🚀</thinking>\r\n\r\n答案',
    '<thinking>a</thinking>\nb</thinking>\n\ntext',
    '<thinking>unfinished </think',
    'plain <thinking>literal</thinking>\n\ntext',
  ])('has identical semantics at every two-way split: %j', (input) => {
    const expected = semantics(decode([input]));
    for (const chunks of everyTwoWaySplit(input)) {
      expect(semantics(decode(chunks)), JSON.stringify(chunks)).toEqual(expected);
    }
  });

  it('has identical semantics at every three-way split across both delimiters', () => {
    for (const input of [
      '<thinking>abc.</thinking>\n\nxyz',
      '<thinking>甲🚀乙</thinking>\r\n\r\n正文',
    ]) {
      const expected = semantics(decode([input]));
      for (const chunks of everyThreeWaySplit(input)) {
        expect(semantics(decode(chunks)), JSON.stringify(chunks)).toEqual(expected);
      }
    }
  });

  it('does not split a surrogate pair across emitted thinking items', () => {
    const decoder = new LegacyThinkingDecoder();
    const high = '\ud83d';
    const low = '\ude80';
    const items = decoder.feed(`<thinking>${high}`);
    expect(items).toEqual([{ type: 'thinking_start' }]);
    expect(decoder.feed(`${low}</thinking>\n\n`)).toEqual([
      { type: 'thinking', text: '🚀' },
      { type: 'thinking_end', reason: 'delimiter' },
    ]);
  });

  it('retains a bounded suffix for arbitrarily large streams', () => {
    const decoder = new LegacyThinkingDecoder();
    decoder.feed('<thinking>');

    for (let index = 0; index < 100; index++) {
      decoder.feed(`${'x'.repeat(10_000)}</think`);
      expect(decoder.bufferedCodeUnits).toBeLessThanOrEqual(
        LEGACY_THINKING_MAX_BUFFERED_CODE_UNITS,
      );
    }

    decoder.feed('ing>\n');
    expect(decoder.bufferedCodeUnits).toBeLessThanOrEqual(LEGACY_THINKING_MAX_BUFFERED_CODE_UNITS);
  });

  it('bounds a whitespace-only undecided prologue', () => {
    const decoder = new LegacyThinkingDecoder();
    const items: LegacyThinkingDecoderItem[] = [];
    for (let index = 0; index < 1_000; index++) {
      items.push(...decoder.feed(' '));
      expect(decoder.bufferedCodeUnits).toBeLessThanOrEqual(
        LEGACY_THINKING_MAX_BUFFERED_CODE_UNITS,
      );
    }
    items.push(...decoder.finish());
    expect(semantics(items).text).toBe(' '.repeat(1_000));
  });
});

describe('LegacyThinkingDecoder complete-text semantics', () => {
  // 曾由 thinking-detector.ts 的 extractThinkingFromCompleteText 承担；该模块在
  // decoder 接管两条路径后已无生产调用点，语法断言并入这里。
  it('splits a fully framed response into its two channels', () => {
    const result = semantics(decode(['<thinking>Reasoning.</thinking>\n\nAnswer']));

    expect(result.thinking).toBe('Reasoning.');
    expect(result.text).toBe('Answer');
  });

  it('keeps an unclosed framed body in thinking instead of visible text', () => {
    const result = semantics(decode(['<thinking>unfinished.']));

    expect(result.thinking).toBe('unfinished.');
    expect(result.text).toBe('');
    expect(result.endReasons).toEqual(['eof_unclosed']);
  });
});
