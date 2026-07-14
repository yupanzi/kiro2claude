import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../../src/claude/types.js';
import { convertOpenAiRequest } from '../../src/openai/converter.js';
import type { ChatCompletionRequest } from '../../src/openai/types.js';

function base(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return { model: 'gpt-5.6-sol', messages: [], ...overrides };
}

/** 取一条消息的 content block 数组(断言用)。 */
function blocks(m: Message): ContentBlock[] {
  return Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
}

describe('convertOpenAiRequest: 角色与 content', () => {
  it('system + developer → system[]', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'developer', content: 'follow policy' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );
    expect(r.system).toEqual([{ text: 'be terse' }, { text: 'follow policy' }]);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[0].content).toBe('hi');
  });

  it('user parts: text + data: image → text/image 块;远程 url → 占位', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
              { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
            ],
          },
        ],
      }),
    );
    const b = blocks(r.messages[0]);
    expect(b[0]).toEqual({ type: 'text', text: 'look' });
    expect(b[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    // 远程 URL → 中性文本占位(不 fetch)
    expect(b[2].type).toBe('text');
    expect(String(b[2].text)).toContain('base64');
  });

  it('assistant.tool_calls → tool_use 块(arguments 字符串 JSON.parse)', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '20C sunny' },
          { role: 'user', content: 'thanks' },
        ],
      }),
    );
    // assistant → tool_use 块
    const asst = r.messages.find((m) => m.role === 'assistant');
    expect(asst).toBeDefined();
    const tu = blocks(asst as Message).find((b) => b.type === 'tool_use');
    expect(tu).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });
    expect((tu as ContentBlock).input).toEqual({ city: 'Tokyo' });
    // tool 消息 → user 消息带 tool_result
    const toolMsg = r.messages.find(
      (m) => m.role === 'user' && blocks(m).some((b) => b.type === 'tool_result'),
    );
    const tr = blocks(toolMsg as Message).find((b) => b.type === 'tool_result');
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '20C sunny' });
  });

  it('坏的 tool_call arguments JSON → input 空对象(不抛)', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'f', arguments: 'not json' } },
            ],
          },
        ],
      }),
    );
    const tu = blocks(r.messages[0]).find((b) => b.type === 'tool_use');
    expect((tu as ContentBlock).input).toEqual({});
  });
});

describe('convertOpenAiRequest: tools / tool_choice', () => {
  it('function tools → {name,description,input_schema}', () => {
    const r = convertOpenAiRequest(
      base({
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
      }),
    );
    expect(r.tools).toEqual([
      {
        name: 'get_weather',
        description: 'weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
  });

  it("tool_choice='none' → 丢 tools", () => {
    const r = convertOpenAiRequest(
      base({
        tool_choice: 'none',
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
    );
    expect(r.tools).toBeUndefined();
  });

  it('非 function 工具被忽略', () => {
    const r = convertOpenAiRequest(
      base({
        tools: [
          { type: 'web_search', function: { name: 'x' } },
          { type: 'function', function: { name: 'real' } },
        ] as ChatCompletionRequest['tools'],
      }),
    );
    expect(r.tools).toEqual([{ name: 'real', description: undefined, input_schema: undefined }]);
  });
});

describe('convertOpenAiRequest: reasoning_effort → thinking/output_config', () => {
  it('minimal → low', () => {
    const r = convertOpenAiRequest(base({ reasoning_effort: 'minimal' }));
    expect(r.thinking).toEqual({ type: 'adaptive', budget_tokens: 20000 });
    expect(r.output_config).toEqual({ effort: 'low' });
  });

  it('high / xhigh / max 透传', () => {
    for (const e of ['high', 'xhigh', 'max']) {
      const r = convertOpenAiRequest(base({ reasoning_effort: e }));
      expect(r.output_config).toEqual({ effort: e });
    }
  });

  it('缺省不注入 thinking/output_config', () => {
    const r = convertOpenAiRequest(base({}));
    expect(r.thinking).toBeUndefined();
    expect(r.output_config).toBeUndefined();
  });

  it('未知 effort 不注入', () => {
    const r = convertOpenAiRequest(base({ reasoning_effort: 'ultra' }));
    expect(r.thinking).toBeUndefined();
  });
});

describe('convertOpenAiRequest: 其它字段', () => {
  it('max_completion_tokens 优先于 max_tokens', () => {
    expect(
      convertOpenAiRequest(base({ max_completion_tokens: 100, max_tokens: 50 })).max_tokens,
    ).toBe(100);
    expect(convertOpenAiRequest(base({ max_tokens: 50 })).max_tokens).toBe(50);
    expect(convertOpenAiRequest(base({})).max_tokens).toBe(32000);
  });

  it('user → metadata.user_id', () => {
    expect(convertOpenAiRequest(base({ user: 'u-42' })).metadata).toEqual({ user_id: 'u-42' });
    expect(convertOpenAiRequest(base({})).metadata).toBeUndefined();
  });

  it('model / stream 透传', () => {
    const r = convertOpenAiRequest(base({ model: 'gpt-5.6-luna', stream: true }));
    expect(r.model).toBe('gpt-5.6-luna');
    expect(r.stream).toBe(true);
  });
});

describe('convertOpenAiRequest: 并行工具结果合并(避免幻影 assistant OK)', () => {
  it('连续 tool 消息合并成单条 user(多 tool_result 块)', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'a', type: 'function', function: { name: 'fa', arguments: '{}' } },
              { id: 'b', type: 'function', function: { name: 'fb', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'a', content: 'RA' },
          { role: 'tool', tool_call_id: 'b', content: 'RB' },
        ],
      }),
    );
    // user('go'), assistant(2 tool_use), user([resultA, resultB]) —— 两个工具结果合并成一条
    expect(r.messages).toHaveLength(3);
    const last = r.messages[2];
    expect(last.role).toBe('user');
    const b = blocks(last);
    expect(b).toHaveLength(2);
    expect(b.every((x) => x.type === 'tool_result')).toBe(true);
    expect((b[0] as { tool_use_id?: string }).tool_use_id).toBe('a');
    expect((b[1] as { tool_use_id?: string }).tool_use_id).toBe('b');
  });

  it('工具结果被普通 user 消息隔开时不合并', () => {
    const r = convertOpenAiRequest(
      base({
        messages: [
          { role: 'tool', tool_call_id: 'a', content: 'RA' },
          { role: 'user', content: 'interject' },
          { role: 'tool', tool_call_id: 'b', content: 'RB' },
        ],
      }),
    );
    expect(r.messages).toHaveLength(3); // 非连续 → 不合并
  });
});
