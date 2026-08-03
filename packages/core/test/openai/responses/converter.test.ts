import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../../src/claude/converter.js';
import type { ContentBlock, Message } from '../../../src/claude/types.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import type { ResponsesRequest } from '../../../src/openai/responses/types.js';

function base(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return { model: 'gpt-5-codex', input: 'hi', ...overrides };
}
/** 只取 payload(绝大多数用例不关心 customToolNames)。 */
function conv(req: ResponsesRequest) {
  return convertResponsesRequest(req).payload;
}
function blocks(m: Message): ContentBlock[] {
  return Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
}

describe('convertResponsesRequest', () => {
  it('input string → 单条 user 消息;instructions → system', () => {
    const r = conv(base({ instructions: 'be terse', input: 'hello' }));
    expect(r.system).toEqual([{ text: 'be terse' }]);
    expect(r.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('input items: message(user parts) / system → system[]', () => {
    const r = conv(
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
    const r = conv(
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
    const r = conv(
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
    const r = conv(
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
    const r = conv(
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
    expect(conv(base({ max_output_tokens: 500 })).max_tokens).toBe(500);
    expect(conv(base({})).max_tokens).toBe(32000);
  });
});

// ============================================================================
// code mode(Codex 对内部已知模型名的请求形态):工具在 input 的 additional_tools 里
// ============================================================================

describe('convertResponsesRequest — code mode', () => {
  it('顶层无 tools 时,从 additional_tools item 取工具', () => {
    const { payload } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{ type: 'function', name: 'wait', description: 'w', parameters: {} }],
          },
          { role: 'user', content: 'go' },
        ],
      }),
    );
    expect(payload.tools?.map((t) => t.name)).toEqual(['wait']);
    // additional_tools item 本身不得变成消息(它 role 是 developer,误当 message
    // 会把整个工具集灌进 system)
    expect(payload.messages).toEqual([{ role: 'user', content: 'go' }]);
    expect(payload.system).toBeUndefined();
  });

  it('custom(freeform)工具 → 单 input 字符串字段的替身 schema + 适配说明,并登记名字', () => {
    const { payload, customToolNames } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        input: [
          {
            type: 'additional_tools',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description: 'Run JavaScript',
                format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' },
              },
            ],
          },
        ],
      }),
    );
    expect(customToolNames).toEqual(new Set(['exec']));
    expect(payload.tools?.[0]?.input_schema).toEqual({
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
      additionalProperties: false,
    });
    // 原描述完整保留 + 末尾追加适配说明(不追加则模型会照 "not JSON" 吐裸文本)
    expect(payload.tools?.[0]?.description).toContain('Run JavaScript');
    expect(payload.tools?.[0]?.description).toContain('`input` string field');
  });

  it('namespace / web_search 仍被忽略(Codex 拒绝直调 namespace 子工具)', () => {
    const { payload } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        input: [
          {
            type: 'additional_tools',
            tools: [
              { type: 'function', name: 'keep', parameters: {} },
              {
                type: 'namespace',
                name: 'collaboration',
                tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }],
              },
              { type: 'web_search' },
            ],
          },
        ],
      }),
    );
    expect(payload.tools?.map((t) => t.name)).toEqual(['keep']);
  });

  it('custom_tool_call → tool_use(裸文本包回 {input});custom_tool_call_output 数组 → tool_result 文本', () => {
    const { payload } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        input: [
          { role: 'user', content: 'write a file' },
          {
            type: 'custom_tool_call',
            status: 'completed',
            call_id: 'call_x',
            name: 'exec',
            input: 'await tools.apply_patch(`*** Begin Patch`);',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_x',
            output: [
              { type: 'input_text', text: 'Script completed' },
              { type: 'input_text', text: 'wrote hello.txt' },
            ],
          },
        ],
      }),
    );
    const asst = payload.messages.find((m) => m.role === 'assistant');
    const tu = blocks(asst as Message).find((b) => b.type === 'tool_use');
    expect(tu).toMatchObject({ type: 'tool_use', id: 'call_x', name: 'exec' });
    // 裸文本必须包成 {input:…},与上送的替身 schema 同形
    expect((tu as ContentBlock).input).toEqual({
      input: 'await tools.apply_patch(`*** Begin Patch`);',
    });
    const toolMsg = payload.messages.find(
      (m) => m.role === 'user' && blocks(m).some((b) => b.type === 'tool_result'),
    );
    const tr = blocks(toolMsg as Message).find((b) => b.type === 'tool_result');
    // output 是 part 数组(≠ function_call_output 的字符串),须归一成文本
    expect(tr).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'call_x',
      content: 'Script completed\nwrote hello.txt',
    });
  });

  it('顶层 tools 与 additional_tools 取并集,同名以顶层为准', () => {
    const { payload } = convertResponsesRequest(
      base({
        tools: [{ type: 'function', name: 'dup', description: 'from-top', parameters: {} }],
        input: [
          {
            type: 'additional_tools',
            tools: [
              { type: 'function', name: 'dup', description: 'from-additional', parameters: {} },
              { type: 'function', name: 'extra', parameters: {} },
            ],
          },
        ],
      }),
    );
    expect(payload.tools?.map((t) => t.name)).toEqual(['dup', 'extra']);
    expect(payload.tools?.[0]?.description).toBe('from-top');
  });

  it('tool_choice=none 时不产工具,也不登记 custom 名字', () => {
    const { payload, customToolNames } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        tool_choice: 'none',
        input: [{ type: 'additional_tools', tools: [{ type: 'custom', name: 'exec' }] }],
      }),
    );
    expect(payload.tools).toBeUndefined();
    expect(customToolNames.size).toBe(0);
  });
});

// ============================================================================
// 真实 wire fixture:抓自 Docker 里的真实 Codex(code mode),脱敏 + 截断长文本。
// 钉住的是**上游客户端实际发什么**,而非我们以为它发什么——形态变了这条先红。
// ============================================================================

describe('convertResponsesRequest — 真实 Codex code mode 抓包', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/responses/codex-code-mode-request.json', import.meta.url),
      'utf8',
    ),
  ) as ResponsesRequest;
  // 纯函数 + 冻结输入,转一次给全组用
  const { payload, customToolNames } = convertResponsesRequest(fixture);
  const allBlocks = payload.messages.flatMap(blocks);

  it('顶层无 tools/instructions,工具全在 additional_tools 里', () => {
    expect(fixture.tools).toBeUndefined();
    expect(fixture.instructions).toBeUndefined();
  });

  it('4 个工具 → 上送 3 个(namespace 丢弃),freeform exec 被登记', () => {
    expect(payload.tools?.map((t) => t.name)).toEqual(['exec', 'wait', 'request_user_input']);
    expect(customToolNames).toEqual(new Set(['exec']));
  });

  it('工具调用往返还原:custom_tool_call → tool_use,output 数组 → tool_result 文本', () => {
    const tu = allBlocks.find((b) => b.type === 'tool_use');
    expect(tu?.input).toMatchObject({ input: expect.stringContaining('tools.') });
    const tr = allBlocks.find((b) => b.type === 'tool_result');
    expect(tr?.content).toContain('Script completed');
  });

  it('developer message → system(instructions 缺席时的唯一 system 来源)', () => {
    expect(payload.system?.length ?? 0).toBeGreaterThan(0);
  });

  it('真实长度的 freeform 描述在默认 cap 下,适配说明不被截断', () => {
    // 说明是载荷性的——丢了模型就不知道该把裸文本填进 input 字段,而 description cap 从
    // **尾部**截,它是第一个被切的。
    // ⚠ 不能直接用 fixture 的描述:它在脱敏时被截到百余字,离 32K cap 差三个数量级,
    // 那样的断言恒真、测不出任何回归。这里用真实观测长度(Codex `exec` 实测 10199 字符)。
    const REAL_FREEFORM_DESCRIPTION_LEN = 10_199;
    const { payload: p } = convertResponsesRequest(
      base({
        model: 'gpt-5.6-sol',
        input: [
          {
            type: 'additional_tools',
            tools: [
              {
                type: 'custom',
                name: 'exec',
                description: 'x'.repeat(REAL_FREEFORM_DESCRIPTION_LEN),
              },
            ],
          },
          { role: 'user', content: 'go' },
        ],
      }),
    );
    const execDesc = (desc: unknown): string =>
      (
        (
          JSON.parse(
            JSON.stringify(
              convertRequest(p, { toolDescriptionMaxLen: desc as number }).conversationState,
            ),
          ) as {
            currentMessage: {
              userInputMessage: {
                userInputMessageContext: {
                  tools: { toolSpecification: { name: string; description: string } }[];
                };
              };
            };
          }
        ).currentMessage.userInputMessage.userInputMessageContext.tools.find(
          (t) => t.toolSpecification.name === 'exec',
        ) as { toolSpecification: { description: string } }
      ).toolSpecification.description;

    // 默认 cap(32768)> 真实描述 + 说明 → 说明完整保留在尾部
    expect(execDesc(undefined)).toMatch(/`input` string field\.$/);
    // 反向:cap 压到描述长度以下,说明确实会被切掉——证明这条断言真的在测截断
    expect(execDesc(REAL_FREEFORM_DESCRIPTION_LEN)).not.toMatch(/`input` string field\.$/);
  });
});
