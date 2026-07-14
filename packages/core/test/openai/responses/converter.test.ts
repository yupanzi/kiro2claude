import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '../../../src/claude/types.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import type { ResponsesRequest } from '../../../src/openai/responses/types.js';

function base(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: 'gpt-5-codex', input: 'hi', ...overrides };
}
function blocks(m: Message): ContentBlock[] {
  return Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
}

describe('convertResponsesRequest', () => {
  it('input string → 单条 user 消息;instructions → system', () => {
    const r = convertResponsesRequest(base({ instructions: 'be terse', input: 'hello' }));
    expect(r.system).toEqual([{ text: 'be terse' }]);
    expect(r.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('input items: message(user parts) / system → system[]', () => {
    const r = convertResponsesRequest(
      base({
        input: [
          { type: 'message', role: 'system', content: 'sys rule' },
          { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        ],
      }),
    );
    expect(r.system).toEqual([{ text: 'sys rule' }]);
    expect(blocks(r.messages[0])).toEqual([{ type: 'text', text: 'q' }]);
  });

  it('function_call → assistant tool_use;function_call_output → user tool_result', () => {
    const r = convertResponsesRequest(
      base({
        input: [
          { role: 'user', content: 'weather?' },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Tokyo"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: '20C' },
        ],
      }),
    );
    const asst = r.messages.find((m) => m.role === 'assistant');
    const tu = blocks(asst as Message).find((b) => b.type === 'tool_use');
    expect(tu).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather' });
    expect((tu as ContentBlock).input).toEqual({ city: 'Tokyo' });
    const toolMsg = r.messages.find(
      (m) => m.role === 'user' && blocks(m).some((b) => b.type === 'tool_result'),
    );
    const tr = blocks(toolMsg as Message).find((b) => b.type === 'tool_result');
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: '20C' });
  });

  it('reasoning item 被忽略(GPT 加密不可复原)', () => {
    const r = convertResponsesRequest(
      base({
        input: [
          { type: 'reasoning', id: 'rs_1', encrypted_content: 'xxx' },
          { role: 'user', content: 'go' },
        ],
      }),
    );
    expect(r.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('扁平 tools → Claude tools;reasoning.effort → thinking/output_config', () => {
    const r = convertResponsesRequest(
      base({
        tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }],
        reasoning: { effort: 'high' },
      }),
    );
    expect(r.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
    expect(r.output_config).toEqual({ effort: 'high' });
    expect(r.thinking).toEqual({ type: 'adaptive', budget_tokens: 20000 });
  });

  it('input_image data URI → image 块', () => {
    const r = convertResponsesRequest(
      base({
        input: [
          {
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }],
          },
        ],
      }),
    );
    expect(blocks(r.messages[0])[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
  });

  it('max_output_tokens → max_tokens', () => {
    expect(convertResponsesRequest(base({ max_output_tokens: 500 })).max_tokens).toBe(500);
    expect(convertResponsesRequest(base({})).max_tokens).toBe(32000);
  });
});
