import { describe, expect, it } from 'vitest';
import { reduceKiroResponse } from '../../src/claude/non-stream-reduce.js';
import { buildToolTextRegistry } from '../../src/claude/tool-call-text.js';
import type { Tool } from '../../src/claude/types.js';
import {
  buildAssistantResponseFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

const MODEL = 'claude-opus-4-6';

const TOOLS: Tool[] = [
  {
    name: 'Read',
    description: 'read a file',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' } },
      required: ['file_path'],
    },
  },
];
const RESCUE_REGISTRY = buildToolTextRegistry(TOOLS);

const LEAKED_READ = [
  '<invoke name="Read">',
  '<parameter name="file_path">/tmp/example.txt</parameter>',
  '</invoke>',
].join('\n');

function reduce(frames: Buffer[], options: { thinkingEnabled?: boolean; rescue?: boolean } = {}) {
  return reduceKiroResponse(
    Buffer.concat(frames),
    MODEL,
    options.thinkingEnabled ?? true,
    new Map(),
    options.rescue ? RESCUE_REGISTRY : undefined,
  );
}

function assistantFrames(...contents: string[]): Buffer[] {
  return contents.map((content) => buildAssistantResponseFrame(content));
}

describe('reduceKiroResponse: legacy thinking framing', () => {
  it('extracts the Issue #2 period case without leaking the close tag', () => {
    const reduced = reduce(assistantFrames('<thinking>Reasoning.</thinking>\n\nVisible answer'));

    expect(reduced.thinkingText).toBe('Reasoning.');
    expect(reduced.textContent).toBe('Visible answer');
    expect(reduced.toolUses).toEqual([]);
    expect(reduced.stopReason).toBe('end_turn');
    expect(reduced.silentFailure).toBe(false);
  });

  it.each([
    '。',
    '！',
    '？',
    '，',
    '；',
    '：',
    '）',
    '】',
    '…',
  ])('does not let CJK punctuation %s veto the close delimiter', (punctuation) => {
    const reduced = reduce(
      assistantFrames(`<thinking>分析结束${punctuation}</thinking>\n\n可见答案`),
    );

    expect(reduced.thinkingText).toBe(`分析结束${punctuation}`);
    expect(reduced.textContent).toBe('可见答案');
  });

  it('is invariant at every single split across AssistantResponse frames', () => {
    const wireText = '<thinking>Reasoning.</thinking>\n\nVisible answer';

    for (let split = 0; split <= wireText.length; split++) {
      const reduced = reduce(assistantFrames(wireText.slice(0, split), wireText.slice(split)));
      const context = `split=${split}, left=${JSON.stringify(wireText.slice(0, split))}`;

      expect(reduced.thinkingText, context).toBe('Reasoning.');
      expect(reduced.textContent, context).toBe('Visible answer');
      expect(reduced.toolUses, context).toEqual([]);
      expect(reduced.stopReason, context).toBe('end_turn');
    }
  });

  it('accepts CRLF framing and strips one opening CRLF', () => {
    const reduced = reduce(
      assistantFrames(' \t\r\n<thinking>\r\n理由。\r\n</thinking>\r\n\r\n答案'),
    );

    expect(reduced.thinkingText).toBe('理由。\r\n');
    expect(reduced.textContent).toBe('答案');
  });

  it('keeps thinking and visible text in their separate channels', () => {
    const reduced = reduce(
      assistantFrames('<thinking>internal plan?</thinking>\n\nPublic response.'),
    );

    expect(reduced.thinkingText).toBe('internal plan?');
    expect(reduced.textContent).toBe('Public response.');
    expect(reduced.hasToolUse).toBe(false);
  });
});

describe('reduceKiroResponse: a thinking phase that opened is never a silent failure', () => {
  // 判据必须是「thinking 阶段开过」，与流式的 `sawAnyThinking`
  // (`thinkingBlockIndex !== undefined`) 同源。跟着 `thinkingText`（要求内容非空）
  // 走的话，空块会被判空 → 先烧完重试预算再 503，而流式对同一份字节回
  // 200 + max_tokens。见 non-stream-reduce.ts `hasSurfaceableThinking` 头注释。
  it('treats an empty legacy thinking block as truncation, not an empty response', () => {
    const reduced = reduce(assistantFrames('<thinking></thinking>\n\n'));

    expect(reduced.silentFailure).toBe(false);
    expect(reduced.stopReason).toBe('max_tokens');
    expect(reduced.textContent).toBe(' ');
  });

  it('treats a whitespace-only legacy thinking body the same way', () => {
    const reduced = reduce(assistantFrames('<thinking>\n</thinking>\n\n'));

    expect(reduced.silentFailure).toBe(false);
    expect(reduced.stopReason).toBe('max_tokens');
  });

  it('still reports a genuinely contentless response as a silent failure', () => {
    const reduced = reduce(assistantFrames(''));

    expect(reduced.silentFailure).toBe(true);
    expect(reduced.stopReason).toBe('end_turn');
  });

  it('does not force max_tokens when an empty block is followed by visible text', () => {
    const reduced = reduce(assistantFrames('<thinking></thinking>\n\nAnswer.'));

    expect(reduced.silentFailure).toBe(false);
    expect(reduced.stopReason).toBe('end_turn');
    expect(reduced.textContent).toBe('Answer.');
  });
});

describe('reduceKiroResponse: structured ToolUse is a thinking boundary', () => {
  it('accepts a complete close tag at the ToolUse boundary without a blank line', () => {
    const reduced = reduce([
      ...assistantFrames('<thinking>closed.</thinking>'),
      buildToolUseFrame('Read', 'tool-closed', '{"file_path":"/tmp/closed.txt"}', true),
    ]);

    expect(reduced.thinkingText).toBe('closed.');
    expect(reduced.textContent).toBe('');
    expect(reduced.toolUses).toEqual([
      {
        type: 'tool_use',
        id: 'tool-closed',
        name: 'Read',
        input: { file_path: '/tmp/closed.txt' },
      },
    ]);
    expect(reduced.stopReason).toBe('tool_use');
    expect(reduced.silentFailure).toBe(false);
  });

  it('implicitly closes an unclosed thinking block before ToolUse and treats later text as visible', () => {
    const reduced = reduce([
      ...assistantFrames('<thinking>unfinished reasoning。'),
      buildToolUseFrame('Read', 'tool-unclosed', '{"file_path":"/tmp/open.txt"}', true),
      ...assistantFrames('Visible after tool.'),
    ]);

    expect(reduced.thinkingText).toBe('unfinished reasoning。');
    expect(reduced.textContent).toBe('Visible after tool.');
    expect(reduced.toolUses).toHaveLength(1);
    expect(reduced.toolUses[0]).toMatchObject({
      type: 'tool_use',
      id: 'tool-unclosed',
      name: 'Read',
      input: { file_path: '/tmp/open.txt' },
    });
    expect(reduced.stopReason).toBe('tool_use');
  });
});

describe('reduceKiroResponse: native reasoning is authoritative', () => {
  const legacyLookingText = '<thinking>literal.</thinking>\n\nVisible literal.';

  it('an empty native reasoning event disables legacy extraction', () => {
    const reduced = reduce([buildReasoningContentFrame(''), ...assistantFrames(legacyLookingText)]);

    expect(reduced.reasoningText).toBe('');
    expect(reduced.reasoningSignature).toBeUndefined();
    expect(reduced.thinkingText).toBeUndefined();
    expect(reduced.textContent).toBe(legacyLookingText);
  });

  it('a late redacted native reasoning event discards tentative legacy classification', () => {
    const reduced = reduce([
      ...assistantFrames(legacyLookingText),
      buildRedactedReasoningFrame('encrypted-reasoning'),
    ]);

    expect(reduced.reasoningText).toBe('');
    expect(reduced.reasoningSignature).toBeUndefined();
    expect(reduced.thinkingText).toBeUndefined();
    expect(reduced.textContent).toBe(legacyLookingText);
  });

  it('a signature-only native event is authoritative and retains its signature', () => {
    const reduced = reduce([
      ...assistantFrames(legacyLookingText),
      buildReasoningContentFrame('', 'native-signature'),
    ]);

    expect(reduced.reasoningText).toBe('');
    expect(reduced.reasoningSignature).toBe('native-signature');
    expect(reduced.thinkingText).toBeUndefined();
    expect(reduced.textContent).toBe(legacyLookingText);
    expect(reduced.silentFailure).toBe(false);
  });

  it('never rescues a rolled-back legacy thinking draft after a late native frame', () => {
    const mixed = `<thinking>\n${LEAKED_READ}</thinking>\n\nVisible answer.`;
    const reduced = reduce(
      [...assistantFrames(mixed), buildRedactedReasoningFrame('late-encrypted-reasoning')],
      { rescue: true },
    );

    expect(reduced.thinkingText).toBeUndefined();
    expect(reduced.textContent).toBe(mixed);
    expect(reduced.toolUses).toEqual([]);
    expect(reduced.hasToolUse).toBe(false);
  });
});

describe('reduceKiroResponse: tool-call rescue only sees visible text', () => {
  it('keeps an unclosed EOF invoke draft in thinking and matches stream truncation semantics', () => {
    const reduced = reduce(assistantFrames(`<thinking>\n${LEAKED_READ}`), { rescue: true });

    expect(reduced.thinkingText).toBe(LEAKED_READ);
    expect(reduced.textContent).toBe(' ');
    expect(reduced.toolUses).toEqual([]);
    expect(reduced.hasToolUse).toBe(false);
    expect(reduced.stopReason).toBe('max_tokens');
    expect(reduced.silentFailure).toBe(false);
  });

  it('does not rescue a complete registered invoke from inside thinking', () => {
    const reduced = reduce(
      assistantFrames(`<thinking>\n${LEAKED_READ}</thinking>\n\nVisible answer.`),
      { rescue: true },
    );

    expect(reduced.thinkingText).toBe(LEAKED_READ);
    expect(reduced.textContent).toBe('Visible answer.');
    expect(reduced.toolUses).toEqual([]);
    expect(reduced.hasToolUse).toBe(false);
    expect(reduced.stopReason).toBe('end_turn');
  });

  it('rescues the same registered invoke after the thinking close delimiter', () => {
    const reduced = reduce(assistantFrames(`<thinking>plan.</thinking>\n\n${LEAKED_READ}`), {
      rescue: true,
    });

    expect(reduced.thinkingText).toBe('plan.');
    expect(reduced.textContent).toBe('');
    expect(reduced.toolUses).toHaveLength(1);
    expect(reduced.toolUses[0]).toMatchObject({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/tmp/example.txt' },
    });
    expect(reduced.hasToolUse).toBe(true);
    expect(reduced.stopReason).toBe('tool_use');
    expect(reduced.silentFailure).toBe(false);
  });
});
