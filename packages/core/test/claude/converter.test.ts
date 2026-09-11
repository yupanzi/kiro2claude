import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversionError,
  convertRequest,
  getContextWindowSize,
  IDENTITY_OVERRIDE_DIRECTIVE,
  INTERRUPTED_TOOL_RESULT_TEXT,
  mapModel,
  UNSUPPORTED_DOCUMENT_PLACEHOLDER,
  usesNativeReasoning,
} from '../../src/claude/converter.js';
import type { Tool as ClaudeTool, MessagesRequest, Metadata } from '../../src/claude/types.js';
import { preprocessSystem } from '../../src/claude/types.js';
import { logger } from '../../src/shared/logger.js';
import { generateLargeBuffer, generateMinimalPdfBytes } from '../helpers/fixtures.js';

const TOOL_NAME_MAX_LEN = 63;

function baseRequest(overrides: Partial<MessagesRequest> = {}): MessagesRequest {
  return {
    model: 'claude-sonnet-4',
    max_tokens: 1024,
    messages: [],
    stream: false,
    ...overrides,
  };
}

describe('mapModel', () => {
  it('test_map_model_sonnet', () => {
    expect(mapModel('claude-sonnet-4-20250514')).toContain('sonnet');
    expect(mapModel('claude-3-5-sonnet-20241022')).toContain('sonnet');
  });

  it('test_map_model_opus', () => {
    expect(mapModel('claude-opus-4-20250514')).toContain('opus');
  });

  it('test_map_model_haiku', () => {
    expect(mapModel('claude-haiku-4-20250514')).toContain('haiku');
  });

  it('test_map_model_unsupported', () => {
    expect(mapModel('gpt-4')).toBeUndefined();
  });

  it('test_map_model_thinking_suffix_sonnet', () => {
    expect(mapModel('claude-sonnet-4-5-20250929-thinking')).toBe('claude-sonnet-4.5');
  });

  it('test_map_model_thinking_suffix_opus_4_5', () => {
    expect(mapModel('claude-opus-4-5-20251101-thinking')).toBe('claude-opus-4.5');
  });

  it('test_map_model_thinking_suffix_opus_4_6', () => {
    expect(mapModel('claude-opus-4-6-thinking')).toBe('claude-opus-4.6');
  });

  it('test_map_model_opus_4_7', () => {
    expect(mapModel('claude-opus-4-7')).toBe('claude-opus-4.7');
    expect(mapModel('claude-opus-4.7')).toBe('claude-opus-4.7');
  });

  it('test_map_model_thinking_suffix_opus_4_7', () => {
    expect(mapModel('claude-opus-4-7-thinking')).toBe('claude-opus-4.7');
  });

  it('test_map_model_opus_4_8', () => {
    expect(mapModel('claude-opus-4-8')).toBe('claude-opus-4.8');
    expect(mapModel('claude-opus-4.8')).toBe('claude-opus-4.8');
  });

  it('test_map_model_thinking_suffix_opus_4_8', () => {
    expect(mapModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8');
  });

  it('test_map_model_opus_5', () => {
    // opus-5 上游 modelId **无小数点**(claude-opus-5)
    expect(mapModel('claude-opus-5')).toBe('claude-opus-5');
    expect(mapModel('claude-opus-5-thinking')).toBe('claude-opus-5');
    expect(mapModel('anthropic.claude-opus-5')).toBe('claude-opus-5');
    // 大小写 / dated 变体都靠单个 dash-form opus-5 判别子命中（与 sonnet-5 一致）
    expect(mapModel('Claude-Opus-5')).toBe('claude-opus-5');
    expect(mapModel('claude-opus-5-20260720')).toBe('claude-opus-5');
  });

  it('test_map_model_opus_5_not_confused_with_4_5', () => {
    // 边界: opus-5 判别子避开 '4',不误伤 opus 4.5(子串 opus-4-5 / opus-4.5，
    // 不含 opus-5)。回归 bug: 无此隔离时 claude-opus-5 会 fallthrough 到 4.6 兜底。
    expect(mapModel('claude-opus-4-5')).toBe('claude-opus-4.5');
    expect(mapModel('claude-opus-4.5')).toBe('claude-opus-4.5');
    expect(mapModel('claude-opus-4-5-20251101-thinking')).toBe('claude-opus-4.5');
  });

  it('test_map_model_thinking_suffix_haiku', () => {
    expect(mapModel('claude-haiku-4-5-20251001-thinking')).toBe('claude-haiku-4.5');
  });

  it('test_map_model_sonnet_5', () => {
    expect(mapModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(mapModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5');
    expect(mapModel('anthropic.claude-sonnet-5')).toBe('claude-sonnet-5');
  });

  it('test_map_model_sonnet_5_not_confused_with_4_5', () => {
    // 边界: 'claude-sonnet-4-5' 含 '5' 但含的是 'sonnet-4-5',不能被 sonnet-5 规则误伤
    expect(mapModel('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4.5');
    expect(mapModel('claude-sonnet-4-5-20250929-thinking')).toBe('claude-sonnet-4.5');
  });

  it('test_map_model_glm_no_longer_supported', () => {
    expect(mapModel('glm-5')).toBeUndefined();
    expect(mapModel('GLM-5')).toBeUndefined();
    expect(mapModel('glm')).toBeUndefined();
  });

  it('test_map_model_gpt_5_6', () => {
    expect(mapModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(mapModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(mapModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    // 大小写 / 分隔符变体都靠 sol/terra/luna 判别子命中
    expect(mapModel('GPT-5.6-Sol')).toBe('gpt-5.6-sol');
    expect(mapModel('gpt-5-6-terra')).toBe('gpt-5.6-terra');
    // -thinking 后缀
    expect(mapModel('gpt-5.6-luna-thinking')).toBe('gpt-5.6-luna');
  });

  it('test_map_model_gpt_unknown_variant_undefined', () => {
    // 有 gpt 无 sol/terra/luna/codex 判别子 → undefined(400),不静默转发不存在的模型
    expect(mapModel('gpt-4')).toBeUndefined();
    expect(mapModel('gpt-5')).toBeUndefined();
    expect(mapModel('gpt-5.6')).toBeUndefined();
  });

  it('test_map_model_codex_alias', () => {
    // Codex CLI 只对它识别的名字发工具集,故网关把 gpt-*-codex 别名到 gpt-5.6-sol
    expect(mapModel('gpt-5-codex')).toBe('gpt-5.6-sol');
    expect(mapModel('gpt-5.1-codex')).toBe('gpt-5.6-sol');
    expect(mapModel('gpt-5-codex-mini')).toBe('gpt-5.6-sol');
    // sol/terra/luna 判别子优先于 codex
    expect(mapModel('gpt-5.6-terra')).toBe('gpt-5.6-terra');
  });
});

describe('getContextWindowSize / usesNativeReasoning — opus-5', () => {
  it('opus-5 context window 为 1M', () => {
    expect(getContextWindowSize('claude-opus-5')).toBe(1_000_000);
    expect(getContextWindowSize('claude-opus-5-thinking')).toBe(1_000_000);
  });

  it('opus-5 走原生 reasoning(比照 4.7/4.8)', () => {
    expect(usesNativeReasoning('claude-opus-5')).toBe(true);
  });

  it('opus 4.5 边界: 非 1M、非原生(不被 opus-5 改动误伤)', () => {
    expect(getContextWindowSize('claude-opus-4-5')).toBe(200_000);
    expect(usesNativeReasoning('claude-opus-4.5')).toBe(false);
  });
});

describe('convertRequest - chat trigger type', () => {
  it('test_determine_chat_trigger_type', () => {
    // The TS implementation always uses MANUAL; verify that
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req);
    expect(result.conversationState.chatTriggerType).toBe('MANUAL');
  });
});

describe('convertRequest - kiro-cli body shape', () => {
  // converter 统一按 kiro-cli 2.0+ 抓包形态输出 body：
  //   origin=KIRO_CLI + envState（operatingSystem + currentWorkingDirectory）
  //   current message 和所有 history user message 都带这两个字段。
  // 这是和 provider / token-manager 共用同一个 `getKiroClientProfile()` 源的
  // 唯一路径——任何 body 形态偏离都会被这里和 client-profile 测试同时拦住。

  it('KIRO_CLI origin + envState on current message + os renders to current platform', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'hello' },
      ],
    });
    const result = convertRequest(req);

    const uim = result.conversationState.currentMessage.userInputMessage;
    expect(uim.origin).toBe('KIRO_CLI');
    expect(result.conversationState.agentTaskType).toBe('vibe');
    expect(result.conversationState.chatTriggerType).toBe('MANUAL');

    const envState = uim.userInputMessageContext.envState;
    expect(envState).toBeDefined();
    expect(envState?.operatingSystem).toMatch(/^(macos|linux|windows)$/);
    expect(envState?.currentWorkingDirectory).toBe(process.cwd());
  });

  it('history user messages also carry KIRO_CLI origin + envState', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'hello' },
      ],
    });
    const result = convertRequest(req);

    const firstUserHistory = result.conversationState.history.find((m) => m.kind === 'user');
    expect(firstUserHistory).toBeDefined();
    if (firstUserHistory?.kind === 'user') {
      expect(firstUserHistory.userInputMessage.origin).toBe('KIRO_CLI');
      const envState = firstUserHistory.userInputMessage.userInputMessageContext.envState;
      expect(envState).toBeDefined();
      expect(envState?.currentWorkingDirectory).toBe(process.cwd());
    }
  });
});

describe('convertRequest - tool description cap', () => {
  const descOf = (result: ReturnType<typeof convertRequest>): string =>
    result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0]
      .toolSpecification.description;

  const reqWithDesc = (description: string): MessagesRequest =>
    baseRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        {
          name: 'big',
          description,
          input_schema: { type: 'object', properties: {} },
        } as ClaudeTool,
      ],
    });

  it('does not truncate a description within the default 32768 cap', () => {
    // 20000 > 旧的 10000 硬上限,但小于新默认 32768(32K) —— Workflow(18780)这类合法
    // 大工具描述不再被截。实测 Kiro 接受 >=1,000,000 字符,10000 曾是过度保守。
    const tools = descOf(convertRequest(reqWithDesc('x'.repeat(20000))));
    expect(tools.length).toBe(20000);
  });

  it('truncates to the configured toolDescriptionMaxLen when exceeded', () => {
    const tools = descOf(
      convertRequest(reqWithDesc('x'.repeat(20000)), { toolDescriptionMaxLen: 5000 }),
    );
    expect(tools.length).toBe(5000);
  });

  it('truncates by code points, not UTF-16 units (multi-byte safe)', () => {
    // 每个 emoji 占 2 个 UTF-16 code unit 但算 1 个 code point;cap=10 应保留 10 个 emoji。
    const truncated = descOf(
      convertRequest(reqWithDesc('😀'.repeat(50)), { toolDescriptionMaxLen: 10 }),
    );
    expect([...truncated].length).toBe(10);
  });

  it('falls back to the default cap when maxLen is not a positive integer (0/negative)', () => {
    // 直接库调用可绕过 env schema(min:1)。guard 必须回退默认,绝不把 0 当上限截空、
    // 也不把负数交给 slice(0, -n) 丢尾字符。20000 < 默认 32768 → 应完全不截。
    for (const bad of [0, -5, 3.5, Number.NaN]) {
      const desc = descOf(
        convertRequest(reqWithDesc('x'.repeat(20000)), { toolDescriptionMaxLen: bad }),
      );
      expect(desc.length).toBe(20000);
    }
  });
});

describe('convertRequest - tool name mapping', () => {
  it('test_tool_name_mapping_in_convert_request', () => {
    const longToolName = 'mcp__plugin_very_long_server_name__extremely_long_tool_name_exceeds_63';
    expect(longToolName.length).toBeGreaterThan(TOOL_NAME_MAX_LEN);

    const req = baseRequest({
      messages: [{ role: 'user', content: 'test' }],
      tools: [
        {
          name: longToolName,
          description: 'A test tool',
          input_schema: { type: 'object', properties: {} },
        } as ClaudeTool,
      ],
    });

    const result = convertRequest(req);
    expect(result.toolNameMap.size).toBe(1);

    const [short, original] = result.toolNameMap.entries().next().value as [string, string];
    expect(original).toBe(longToolName);
    expect(short.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LEN);

    const tools =
      result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    expect(tools[0].toolSpecification.name).toBe(short);
  });

  it('test_tool_name_mapping_in_history', () => {
    const longToolName = 'mcp__plugin_very_long_server_name__extremely_long_tool_name_exceeds_63';

    const req = baseRequest({
      messages: [
        { role: 'user', content: 'use the tool' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_use', id: 'toolu_01', name: longToolName, input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'done' }],
        },
      ],
      tools: [
        {
          name: longToolName,
          description: 'A test tool',
          input_schema: { type: 'object', properties: {} },
        } as ClaudeTool,
      ],
    });

    const result = convertRequest(req);
    const shortName = result.toolNameMap.entries().next().value![0];

    let found = false;
    for (const msg of result.conversationState.history) {
      if (msg.kind === 'assistant' && msg.assistantResponseMessage.toolUses) {
        for (const tu of msg.assistantResponseMessage.toolUses) {
          if (tu.toolUseId === 'toolu_01') {
            expect(tu.name).toBe(shortName);
            found = true;
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('convertRequest - tool_result image hoisting', () => {
  // Regression guard: Kiro's ToolResult wire format carries text only, so an
  // image returned inside a tool_result (e.g. Claude Code's Read tool reading a
  // large screenshot) must be hoisted to the message-level `images` array — the
  // only vision channel the upstream honours — or the model never sees it.
  const imageToolResult = (toolUseId: string, data: string, extraText?: string) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content: [
      ...(extraText ? [{ type: 'text', text: extraText }] : []),
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ],
  });

  it('hoists a tool_result image to the current message images array', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'describe the screenshot' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_img', name: 'Read', input: {} }],
        },
        { role: 'user', content: [imageToolResult('toolu_img', 'QUJDRA==')] },
      ],
      tools: [
        {
          name: 'Read',
          description: 'read a file',
          input_schema: { type: 'object', properties: {} },
        } as ClaudeTool,
      ],
    });

    const uim = convertRequest(req).conversationState.currentMessage.userInputMessage;

    // image pulled out to the message-level vision channel
    expect(uim.images).toHaveLength(1);
    expect(uim.images[0]).toEqual({ format: 'png', source: { bytes: 'QUJDRA==' } });

    // tool result is preserved and paired, but the base64 never stays inside it
    const tr = uim.userInputMessageContext.toolResults.find((t) => t.toolUseId === 'toolu_img');
    expect(tr).toBeDefined();
    expect(JSON.stringify(tr?.content)).not.toContain('QUJDRA==');
  });

  it('keeps tool_result text while hoisting the image alongside it', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_mix', name: 'Read', input: {} }],
        },
        { role: 'user', content: [imageToolResult('toolu_mix', 'WllYWA==', 'Read image foo.png')] },
      ],
      tools: [
        {
          name: 'Read',
          description: 'read a file',
          input_schema: { type: 'object', properties: {} },
        } as ClaudeTool,
      ],
    });

    const uim = convertRequest(req).conversationState.currentMessage.userInputMessage;

    expect(uim.images).toHaveLength(1);
    expect(uim.images[0]?.source.bytes).toBe('WllYWA==');

    const tr = uim.userInputMessageContext.toolResults.find((t) => t.toolUseId === 'toolu_mix');
    expect(JSON.stringify(tr?.content)).toContain('Read image foo.png');
  });
});

describe('convertRequest - large files, PDFs, unsupported media (silent-drop regression)', () => {
  // These lock in how content that can otherwise cause "empty/wrong responses"
  // flows through the converter: supported images reach the message-level vision
  // channel; large text is never truncated; document/PDF and unsupported image
  // formats are dropped but always *logged* so a missing input is diagnosable.
  // Fixtures are generated in-place (no checked-in binaries beyond the two PNGs).
  const smallPng = fs.readFileSync(new URL('../fixtures/images/test-small.png', import.meta.url));
  const largePng = fs.readFileSync(new URL('../fixtures/images/test-large.png', import.meta.url));

  const readTool = {
    name: 'Read',
    description: 'read a file',
    input_schema: { type: 'object', properties: {} },
  } as ClaudeTool;

  it('inlines a small image block into the message-level images channel', () => {
    const b64 = smallPng.toString('base64');
    const req = baseRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            { type: 'text', text: 'what is in this image' },
          ],
        },
      ],
    });
    const uim = convertRequest(req).conversationState.currentMessage.userInputMessage;
    expect(uim.images).toHaveLength(1);
    expect(uim.images[0]).toEqual({ format: 'png', source: { bytes: b64 } });
    expect(uim.content).toContain('what is in this image');
  });

  it('hoists a large (Read-tool) image from a tool_result to message-level images', () => {
    const b64 = largePng.toString('base64');
    // Sanity: this really is the large fixture that forces Claude Code's Read path.
    expect(b64.length).toBeGreaterThan(100_000);
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'describe the screenshot' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_big', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_big',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
              ],
            },
          ],
        },
      ],
      tools: [readTool],
    });
    const uim = convertRequest(req).conversationState.currentMessage.userInputMessage;
    expect(uim.images).toHaveLength(1);
    expect(uim.images[0]?.source.bytes).toBe(b64);
    // base64 is pulled out of the tool result (Kiro ToolResult carries text only)
    const tr = uim.userInputMessageContext.toolResults.find((t) => t.toolUseId === 'toolu_big');
    expect(JSON.stringify(tr?.content)).not.toContain(b64);
  });

  it('does not truncate a large text tool_result (big file read)', () => {
    const big = generateLargeBuffer(700_000).toString('latin1'); // ~700KB of 'A'
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'read the big file' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_txt', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_txt',
              content: [{ type: 'text', text: big }],
            },
          ],
        },
      ],
      tools: [readTool],
    });
    const result = convertRequest(req);
    // The whole payload is at least as large as the input — nothing was capped.
    expect(JSON.stringify(result).length).toBeGreaterThanOrEqual(big.length);
    const uim = result.conversationState.currentMessage.userInputMessage;
    const tr = uim.userInputMessageContext.toolResults.find((t) => t.toolUseId === 'toolu_txt');
    expect(JSON.stringify(tr?.content)).toContain('A'.repeat(2000));
  });

  it('drops a top-level document (PDF) block and warns (no upstream channel)', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const pdfB64 = generateMinimalPdfBytes().toString('base64');
      const req = baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'summarize this pdf' },
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
              },
            ],
          },
        ],
      });
      const result = convertRequest(req);
      const uim = result.conversationState.currentMessage.userInputMessage;
      // Text survives; the PDF is dropped — not hoisted, not leaked into the wire.
      expect(uim.content).toContain('summarize this pdf');
      expect(uim.images).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(pdfB64);
      // ...but it is diagnosable rather than a mysterious empty/wrong response.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'dropping unsupported content block',
          block_type: 'document',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('drops a document (PDF) returned inside a tool_result and warns', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const pdfB64 = generateMinimalPdfBytes().toString('base64');
      const req = baseRequest({
        messages: [
          { role: 'user', content: 'read the pdf' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_pdf', name: 'Read', input: {} }],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_pdf',
                content: [
                  {
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
                  },
                ],
              },
            ],
          },
        ],
        tools: [readTool],
      });
      const result = convertRequest(req);
      const uim = result.conversationState.currentMessage.userInputMessage;
      expect(uim.images).toHaveLength(0); // a document is not an image → not hoisted
      expect(JSON.stringify(result)).not.toContain(pdfB64); // dropped, not leaked
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'dropping unsupported tool_result content block',
          block_type: 'document',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('replaces a top-level document (PDF) with a text placeholder when rejectUnsupportedDocuments is on', () => {
    const pdfB64 = generateMinimalPdfBytes().toString('base64');
    const req = baseRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize this pdf' },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
            },
          ],
        },
      ],
    });
    const result = convertRequest(req, { rejectUnsupportedDocuments: true });
    const uim = result.conversationState.currentMessage.userInputMessage;
    // The PDF bytes never reach the wire...
    expect(JSON.stringify(result)).not.toContain(pdfB64);
    // ...but instead of vanishing, a neutral placeholder is left beside the
    // original text so the model knows a document was there and unreadable.
    expect(uim.content).toContain('summarize this pdf');
    expect(uim.content).toContain(UNSUPPORTED_DOCUMENT_PLACEHOLDER);
    // A document is not an image → nothing hoisted into the vision channel.
    expect(uim.images).toHaveLength(0);
  });

  it('replaces a document inside a tool_result with a placeholder when rejectUnsupportedDocuments is on', () => {
    const pdfB64 = generateMinimalPdfBytes().toString('base64');
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'read the pdf' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_pdf', name: 'Read', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_pdf',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
                },
              ],
            },
          ],
        },
      ],
      tools: [readTool],
    });
    const result = convertRequest(req, { rejectUnsupportedDocuments: true });
    // base64 never leaks; the placeholder rides in the tool_result text instead.
    expect(JSON.stringify(result)).not.toContain(pdfB64);
    expect(JSON.stringify(result)).toContain(UNSUPPORTED_DOCUMENT_PLACEHOLDER);
  });

  it('still drops documents with no placeholder when rejectUnsupportedDocuments is off (library default)', () => {
    const pdfB64 = generateMinimalPdfBytes().toString('base64');
    const req = baseRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarize this pdf' },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 },
            },
          ],
        },
      ],
    });
    // No options → library default false → legacy silent-drop, no placeholder.
    const result = convertRequest(req);
    const uim = result.conversationState.currentMessage.userInputMessage;
    expect(JSON.stringify(result)).not.toContain(pdfB64);
    expect(uim.content).not.toContain(UNSUPPORTED_DOCUMENT_PLACEHOLDER);
  });

  it('drops an image block with an unsupported media_type and warns', () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    try {
      const req = baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'Qk0=' } },
            ],
          },
        ],
      });
      const uim = convertRequest(req).conversationState.currentMessage.userInputMessage;
      expect(uim.images).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          msg: 'dropping image with unsupported media_type',
          media_type: 'image/bmp',
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('convertRequest - history tool placeholders', () => {
  it('test_history_tools_added_to_tools_list', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: "I'll read the file." },
            { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: '/test.txt' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file content' }],
        },
      ],
    });

    const result = convertRequest(req);
    const tools =
      result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.toolSpecification.name === 'read')).toBe(true);
  });
});

describe('convertRequest - session ID extraction', () => {
  it('test_convert_request_with_session_metadata', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: {
        user_id: 'user_deadbeefcafe0000_account__session_00000000-0000-4000-8000-000000000000',
      } as Metadata,
    });

    const result = convertRequest(req);
    expect(result.conversationState.conversationId).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('test_convert_request_without_metadata', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'Hello' }],
    });
    const result = convertRequest(req);
    // Should be a UUID
    expect(result.conversationState.conversationId.length).toBe(36);
    const dashes = (result.conversationState.conversationId.match(/-/g) ?? []).length;
    expect(dashes).toBe(4);
  });
});

describe('convertRequest - assistant message conversion', () => {
  it('test_convert_assistant_message_tool_use_only', () => {
    // Wrap in a full request because TS exposes only convertRequest publicly
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01ABC',
              name: 'read_file',
              input: { path: '/test.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABC', content: 'ok' }],
        },
      ],
    });

    // Opt out of identity override so this test only sees the assistant
    // messages produced from the user-provided history.
    const result = convertRequest(req, { identityOverride: false });
    let foundAssistant = false;
    for (const msg of result.conversationState.history) {
      if (msg.kind === 'assistant') {
        const am = msg.assistantResponseMessage;
        // content cannot be empty; should be ' ' placeholder
        expect(am.content.length).toBeGreaterThan(0);
        expect(am.content).toBe(' ');
        const toolUses = am.toolUses!;
        expect(toolUses.length).toBe(1);
        expect(toolUses[0].toolUseId).toBe('toolu_01ABC');
        expect(toolUses[0].name).toBe('read_file');
        foundAssistant = true;
      }
    }
    expect(foundAssistant).toBe(true);
  });

  it('test_convert_assistant_message_with_text_and_tool_use', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me read that file for you.' },
            {
              type: 'tool_use',
              id: 'toolu_02XYZ',
              name: 'read_file',
              input: { path: '/data.json' },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_02XYZ', content: 'ok' }],
        },
      ],
    });

    const result = convertRequest(req);
    let found = false;
    for (const msg of result.conversationState.history) {
      if (msg.kind === 'assistant' && msg.assistantResponseMessage.toolUses) {
        const am = msg.assistantResponseMessage;
        if (am.toolUses?.[0]?.toolUseId === 'toolu_02XYZ') {
          expect(am.content).toBe('Let me read that file for you.');
          expect(am.toolUses.length).toBe(1);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('convertRequest - merge consecutive assistant messages (Issue #79)', () => {
  it('test_consecutive_assistant_with_tool_use_result_pairing', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'Read the config file' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I need to read the file...' },
            { type: 'text', text: ' ' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me read the config.' },
            { type: 'text', text: "I'll read the config file for you." },
            {
              type: 'tool_use',
              id: 'toolu_01XYZ',
              name: 'read_file',
              input: { path: '/config.json' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01XYZ', content: '{"key": "value"}' },
          ],
        },
      ],
    });

    const result = convertRequest(req);
    let foundToolUse = false;
    for (const msg of result.conversationState.history) {
      if (msg.kind === 'assistant' && msg.assistantResponseMessage.toolUses) {
        if (msg.assistantResponseMessage.toolUses.some((t) => t.toolUseId === 'toolu_01XYZ')) {
          foundToolUse = true;
          break;
        }
      }
    }
    expect(foundToolUse).toBe(true);
  });
});

describe('convertRequest - system text folds into the first user message', () => {
  // Kiro 没有 system 字段,additionalContext 上游静默丢弃(2026-09-10 实测),system 只能作为
  // user 文本进模型。契约:前置到**首条** user 消息正文,不造任何 assistant 轮次(旧实现的
  // `user: system / assistant: "I will follow these instructions."` 假对话对已移除,见
  // test/static/no-fabricated-turns.test.ts)。baseRequest 的 claude-sonnet-4 非原生 reasoning,
  // 未开 thinking 时无 `<thinking_mode>` 前缀,故可以整串 toBe 精确钉形态。
  const SYSTEM = 'You are a helpful coding assistant.';
  const withSystem = (messages: MessagesRequest['messages']) =>
    convertRequest(baseRequest({ system: [{ type: 'text', text: SYSTEM }], messages }));

  it('single turn: system heads the currentMessage text, history is empty', () => {
    const result = withSystem([{ role: 'user', content: 'hello' }]);
    expect(result.conversationState.history).toHaveLength(0);
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${SYSTEM}\n\nhello`,
    );
  });

  it('multi turn: system stays on history[0] (the first user message); later turns are verbatim', () => {
    const result = withSystem([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    const { history, currentMessage } = result.conversationState;
    expect(history).toHaveLength(2);
    expect(history[0].kind).toBe('user');
    if (history[0].kind === 'user') {
      expect(history[0].userInputMessage.content).toBe(`${SYSTEM}\n\nfirst`);
    }
    expect(history[1].kind).toBe('assistant');
    if (history[1].kind === 'assistant') {
      expect(history[1].assistantResponseMessage.content).toBe('reply');
    }
    expect(currentMessage.userInputMessage.content).toBe('second');
  });

  it('never fabricates an assistant turn: history maps 1:1 onto the client turns', () => {
    const result = withSystem([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
      { role: 'user', content: 'e' },
    ]);
    const kinds = result.conversationState.history.map((m) => m.kind);
    expect(kinds).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(result.conversationState)).not.toContain(
      'I will follow these instructions',
    );
  });

  it('folds into the first *user* message even when the client leads with an assistant message', () => {
    // OpenAI chat UIs send [assistant greeting, user]. The Kiro history then opens
    // with an assistant turn; a 2026-09-11 live probe confirmed the upstream accepts
    // that shape and the model answers normally (test/manual/inserted-content-live.mjs,
    // scenario `leading-assistant`).
    const result = withSystem([
      { role: 'assistant', content: 'leading' },
      { role: 'user', content: 'q' },
    ]);
    const { history, currentMessage } = result.conversationState;
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe('assistant');
    expect(currentMessage.userInputMessage.content).toBe(`${SYSTEM}\n\nq`);
  });

  it('block-array first user message: same wire bytes as the string form, other blocks are kept', () => {
    // The prefix is joined on the Kiro message after the client content has been
    // flattened, so the two Anthropic-equivalent spellings of one request cannot
    // drift apart (they once did: "SYS\n\nhello" vs "SYS\nhello"). Claude Code and
    // Codex both send block arrays; the byte-exact cases above use strings.
    const asString = withSystem([{ role: 'user', content: 'look' }]);
    const result = withSystem([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' },
          },
        ],
      },
    ] as MessagesRequest['messages']);
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current.content).toBe(`${SYSTEM}\n\nlook`);
    expect(current.content).toBe(
      asString.conversationState.currentMessage.userInputMessage.content,
    );
    expect(current.images).toHaveLength(1);
  });

  it('system prefix stays ahead of the multi-image legend', () => {
    // prependImageLegend runs on the assembled content and the prefix is joined
    // afterwards, so the system text is still the first thing in the message.
    const png = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJDRA==' },
    };
    const result = withSystem([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'orphan',
            content: [{ type: 'text', text: '/w/o.png' }, png],
          },
          png,
        ],
      },
    ] as MessagesRequest['messages']);
    const content = result.conversationState.currentMessage.userInputMessage.content;
    expect(content.startsWith(`${SYSTEM}\n\n[Attached images, in order:`)).toBe(true);
  });

  it('blank system blocks inject nothing: [{text:""},{text:""}] and whitespace-only', () => {
    // Joining two empty blocks yields "\n", which is truthy; blank blocks are
    // dropped before the join so no stray newlines reach the first user message.
    for (const system of [
      [
        { type: 'text', text: '' },
        { type: 'text', text: '' },
      ],
      [{ type: 'text', text: '   \n' }],
    ]) {
      const result = convertRequest(
        baseRequest({ system, messages: [{ role: 'user', content: 'hi' }] }),
      );
      expect(result.conversationState.currentMessage.userInputMessage.content).toBe('hi');
      expect(result.conversationState.history).toHaveLength(0);
    }
  });

  it('later tool_result-only user turns are never touched', () => {
    const result = withSystem([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'data' }] },
    ] as MessagesRequest['messages']);
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current.content).toBe('');
    expect(current.userInputMessageContext.toolResults.map((r) => r.toolUseId)).toEqual(['tu1']);
  });

  it('empty system [{text: ""}] is byte-identical to no system', () => {
    // 判断基于拼接后的 systemContent 真值而非数组长度:客户端发 system:[{text:''}] 时不能
    // 拼出一个只剩分隔符的空前缀。
    const empty = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: '' }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const none = convertRequest(baseRequest({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(empty.conversationState.currentMessage).toEqual(none.conversationState.currentMessage);
    expect(empty.conversationState.history).toEqual(none.conversationState.history);
    expect(none.conversationState.currentMessage.userInputMessage.content).toBe('hi');
  });

  it('empty system wire "" / [] normalize through preprocessSystem and inject nothing', () => {
    expect(preprocessSystem('')).toEqual([{ text: '' }]);
    expect(preprocessSystem([])).toBeUndefined();
    for (const system of [preprocessSystem(''), preprocessSystem([])]) {
      const result = convertRequest(
        baseRequest({ system, messages: [{ role: 'user', content: 'hi' }] }),
      );
      expect(result.conversationState.currentMessage.userInputMessage.content).toBe('hi');
      expect(result.conversationState.history).toHaveLength(0);
    }
  });

  it('empty user content "" / []: no throw, the folded text is the whole content (no dangling separator)', () => {
    for (const content of ['', []] as const) {
      const result = withSystem([{ role: 'user', content }] as MessagesRequest['messages']);
      expect(result.conversationState.currentMessage.userInputMessage.content).toBe(SYSTEM);
    }
  });

  it('rejects a message role other than user/assistant/system instead of dropping it', () => {
    // Dropping the message silently would lose client content (and let the
    // continuation bridge fuse into a real user turn); the Anthropic API rejects
    // such roles too. Checked after system-role folding, so reminders still pass.
    const messages = [
      { role: 'user', content: 'x' },
      { role: 'tool', content: 'weird' },
    ] as unknown as MessagesRequest['messages'];
    expect(() => withSystem(messages)).toThrow(ConversionError);
    try {
      withSystem(messages);
    } catch (e) {
      expect((e as ConversionError).code).toBe('InvalidRole');
    }
  });
});

describe('convertRequest - identity override', () => {
  // 断言用 IDENTITY_OVERRIDE_DIRECTIVE 常量:文案微调不会让测试沉默 flake。
  // 默认**关**:实测 opus-5 4/13、opus-4-6 0/2 生效(见 IDENTITY_OVERRIDE_DIRECTIVE 头注释)。
  const SYSTEM = 'You are a helpful coding assistant.';

  it('default (options omitted): no directive anywhere on the wire', () => {
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
    );
    expect(JSON.stringify(result.conversationState)).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${SYSTEM}\n\nhello`,
    );
  });

  it('identityOverride: false explicit behaves identically to default', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: SYSTEM }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(
      convertRequest(req, { identityOverride: false }).conversationState.currentMessage,
    ).toEqual(convertRequest(req).conversationState.currentMessage);
  });

  it('identityOverride: true, with system: system, blank line, directive, then the first user text', () => {
    // byte 级钉死顺序:客户端 system 原文 + 空行 + 身份指令 + 空行 + 首条 user 原文。
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
      { identityOverride: true },
    );
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${SYSTEM}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}\n\nhello`,
    );
  });

  it('identityOverride: true, no system: the directive alone heads the first user text', () => {
    const result = convertRequest(baseRequest({ messages: [{ role: 'user', content: 'hi' }] }), {
      identityOverride: true,
    });
    expect(result.conversationState.history).toHaveLength(0);
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${IDENTITY_OVERRIDE_DIRECTIVE}\n\nhi`,
    );
  });

  it('identityOverride: true, multi turn: directive only on history[0], current message verbatim', () => {
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: SYSTEM }],
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'go' },
        ],
      }),
      { identityOverride: true },
    );
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toBe(
        `${SYSTEM}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}\n\nfirst`,
      );
    }
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe('go');
  });

  it('identityOverride: true + empty user content: the directive is the whole content', () => {
    for (const content of ['', []] as const) {
      const result = convertRequest(
        baseRequest({ messages: [{ role: 'user', content }] } as Partial<MessagesRequest>),
        {
          identityOverride: true,
        },
      );
      expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
        IDENTITY_OVERRIDE_DIRECTIVE,
      );
    }
  });

  it('identityOverride: true + legacy thinking: prefix, then system, then directive, then user text', () => {
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: 'hello' }],
        thinking: { type: 'enabled', budget_tokens: 8000 },
      }),
      { identityOverride: true },
    );
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `<thinking_mode>enabled</thinking_mode><max_thinking_length>8000</max_thinking_length>\n${SYSTEM}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}\n\nhello`,
    );
  });
});

describe('convertRequest - thinking prefix injection', () => {
  // 请求侧 `<thinking_mode>` 注入的回归覆盖(与身份覆写正交,这里只钉 thinking)。
  // baseRequest 的 claude-sonnet-4 非原生 reasoning,故 thinking 走 prompt 前缀注入路径。
  const thinking = { type: 'enabled' as const, budget_tokens: 8000 };
  const TAG =
    '<thinking_mode>enabled</thinking_mode><max_thinking_length>8000</max_thinking_length>';

  it('thinking enabled (no system): prefix heads the first user message', () => {
    const result = convertRequest(
      baseRequest({ messages: [{ role: 'user', content: 'hello' }], thinking }),
    );
    expect(result.conversationState.history).toHaveLength(0);
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${TAG}\n\nhello`,
    );
  });

  it('thinking enabled + system: prefix, newline, system, then the user text', () => {
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: 'Be brief.' }],
        messages: [{ role: 'user', content: 'hello' }],
        thinking,
      }),
    );
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(
      `${TAG}\nBe brief.\n\nhello`,
    );
  });

  it('empty system (text: "") + thinking: byte-identical to no-system + thinking', () => {
    // 回归:存在判断基于拼接后的 systemContent 真值而非 req.system 数组长度。
    const withEmptySystem = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: '' }],
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
      }),
    );
    const withNoSystem = convertRequest(
      baseRequest({ messages: [{ role: 'user', content: 'hi' }], thinking }),
    );
    expect(withEmptySystem.conversationState.currentMessage).toEqual(
      withNoSystem.conversationState.currentMessage,
    );
    expect(withNoSystem.conversationState.currentMessage.userInputMessage.content).toBe(
      `${TAG}\n\nhi`,
    );
  });

  it('client system already carrying thinking tags is not doubled', () => {
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: '<thinking_mode>enabled</thinking_mode> Be brief.' }],
        messages: [{ role: 'user', content: 'hello' }],
        thinking,
      }),
    );
    const content = result.conversationState.currentMessage.userInputMessage.content;
    expect(content.split('<thinking_mode>').length - 1).toBe(1);
  });

  it('first user text already carrying a thinking block is not doubled (no system)', () => {
    // The prefix is joined to the first user message, so that message is the text
    // that can already carry the block; the dedup must look there, not only at
    // the request system text.
    const tagged =
      '<thinking_mode>enabled</thinking_mode><max_thinking_length>8000</max_thinking_length>\nhello';
    const result = convertRequest(
      baseRequest({ messages: [{ role: 'user', content: tagged }], thinking }),
    );
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe(tagged);
  });

  it('a system prompt that merely mentions <thinking_mode> in prose keeps the prefix', () => {
    // Only a complete tag block counts as "already tagged"; a bare mention is not
    // one, otherwise extended thinking would silently switch off with no log.
    const result = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: 'Never emit literal <thinking_mode> tags in replies.' }],
        messages: [{ role: 'user', content: 'hello' }],
        thinking,
      }),
    );
    expect(result.conversationState.currentMessage.userInputMessage.content).toMatch(
      /^<thinking_mode>enabled<\/thinking_mode>/,
    );
  });

  it('native-reasoning model: no prompt prefix, effort rides the wire field instead', () => {
    const result = convertRequest(
      baseRequest({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hello' }],
        thinking,
      }),
    );
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current.content).toBe('hello');
    expect(current.reasoning).toBeDefined();
  });
});

describe('convertRequest - trailing run of user messages is the current turn', () => {
  // Anthropic 语义:连续同角色消息是一轮。旧实现把末尾连串的前几条塞进 history 并补一条
  // 假 assistant "OK",下一轮同一段又被 mergeUserMessages 合并成一条——形态随轮次漂移。
  const convert = (messages: MessagesRequest['messages']) =>
    convertRequest(baseRequest({ messages })).conversationState;

  it('two trailing user messages merge into one currentMessage; history is empty', () => {
    const state = convert([
      { role: 'user', content: 'My secret code is 7731.' },
      { role: 'user', content: 'What is my secret code?' },
    ]);
    expect(state.history).toHaveLength(0);
    expect(state.currentMessage.userInputMessage.content).toBe(
      'My secret code is 7731.\nWhat is my secret code?',
    );
    expect(JSON.stringify(state)).not.toContain('"OK"');
  });

  it('tool_result turn followed by a user text turn: results and text share the current message', () => {
    const state = convert([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'data' }] },
      { role: 'user', content: 'now summarize' },
    ] as MessagesRequest['messages']);
    expect(state.history.map((m) => m.kind)).toEqual(['user', 'assistant']);
    const current = state.currentMessage.userInputMessage;
    expect(current.content).toBe('now summarize');
    expect(current.userInputMessageContext.toolResults.map((r) => r.toolUseId)).toEqual(['tu1']);
  });

  it('the same two messages have the same shape whether they are current or history', () => {
    // 形态一致性:本轮的 currentMessage 文本 == 下一轮 history 里合并后的文本。
    const now = convert([
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
    ]);
    const later = convert([
      { role: 'user', content: 'A' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'C' },
    ]);
    const head = later.history[0];
    expect(head.kind).toBe('user');
    if (head.kind === 'user') {
      expect(head.userInputMessage.content).toBe(now.currentMessage.userInputMessage.content);
    }
    expect(later.history).toHaveLength(2);
  });
});

describe('convertRequest - tool-search beta (20251119)', () => {
  const realTools: ClaudeTool[] = [
    {
      name: 'get_weather',
      description: 'Get current weather for a city',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      defer_loading: true,
    } as ClaudeTool,
    {
      name: 'get_stock_price',
      description: 'Get stock price by ticker',
      input_schema: {
        type: 'object',
        properties: { ticker: { type: 'string' } },
        required: ['ticker'],
      },
      defer_loading: true,
    } as ClaudeTool,
  ];

  // The synthetic markers a tool-search client sends (no input_schema).
  const regexMarker = {
    type: 'tool_search_tool_regex_20251119',
    name: 'tool_search_tool_regex',
  } as ClaudeTool;
  const bm25Marker = {
    type: 'tool_search_tool_bm25_20251119',
    name: 'tool_search_tool_bm25',
  } as ClaudeTool;

  function outboundTools(req: MessagesRequest) {
    return convertRequest(req).conversationState.currentMessage.userInputMessage
      .userInputMessageContext.tools;
  }

  it('drops the synthetic tool_search marker and forwards real tools with full schema', () => {
    // The marker tool has no input_schema; forwarding it 1:1 would produce a
    // degenerate empty-schema tool that Kiro rejects with HTTP 400 (verified live).
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [...realTools, regexMarker],
    });

    const tools = outboundTools(req);
    // F1: no phantom tool-search tool reaches the wire.
    expect(tools.some((t) => t.toolSpecification.name.startsWith('tool_search_tool_'))).toBe(false);
    // F2: real (deferred) tools are still forwarded, with their full schemas.
    const names = tools.map((t) => t.toolSpecification.name);
    expect(names).toContain('get_weather');
    expect(names).toContain('get_stock_price');
    const weather = tools.find((t) => t.toolSpecification.name === 'get_weather');
    expect(Object.keys(weather?.toolSpecification.inputSchema.json.properties ?? {})).toContain(
      'city',
    );
    expect(tools).toHaveLength(2);
  });

  it('also drops the bm25 marker variant', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [realTools[0], bm25Marker],
    });
    const tools = outboundTools(req);
    expect(tools).toHaveLength(1);
    expect(tools[0].toolSpecification.name).toBe('get_weather');
  });

  it('a long (>63-char) deferred tool name is still shortened after the marker is dropped', () => {
    // The marker skip happens BEFORE mapToolName, so a de-deferred real tool with
    // an over-long name must still go through the 63-char hashing path.
    const longName = 'mcp__plugin_very_long_server_name__extremely_long_tool_name_exceeds_63';
    expect(longName.length).toBeGreaterThan(TOOL_NAME_MAX_LEN);
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: longName,
          description: 'A deferred tool with an over-long name',
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
          defer_loading: true,
        } as ClaudeTool,
        regexMarker,
      ],
    });
    const result = convertRequest(req);
    const tools =
      result.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    // Marker dropped, only the real tool remains, and its name is shortened.
    expect(tools).toHaveLength(1);
    const outName = tools[0].toolSpecification.name;
    expect(outName.length).toBeLessThanOrEqual(TOOL_NAME_MAX_LEN);
    // The mapping back to the original name is recorded (and never keyed on the marker).
    expect(result.toolNameMap.get(outName)).toBe(longName);
    expect([...result.toolNameMap.values()]).not.toContain('tool_search_tool_regex');
  });

  it('negative control: plain tools (no beta fields) are unchanged', () => {
    const plain: ClaudeTool[] = [
      {
        name: 'get_weather',
        description: 'Get weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      } as ClaudeTool,
    ];
    const tools = outboundTools(
      baseRequest({ messages: [{ role: 'user', content: 'hi' }], tools: plain }),
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].toolSpecification.name).toBe('get_weather');
  });

  it('only a marker tool, no real tools → empty tools array, no throw', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [regexMarker],
    });
    expect(() => outboundTools(req)).not.toThrow();
    expect(outboundTools(req)).toHaveLength(0);
  });

  it('history containing tool_search_tool_result / tool_reference blocks does not throw', () => {
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'find a tool' },
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'tool_search_tool_regex',
              input: {},
            },
            { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_reference', name: 'get_weather' },
            { type: 'text', text: 'weather?' },
          ],
        },
      ] as MessagesRequest['messages'],
      tools: [realTools[0], regexMarker],
    });
    expect(() => convertRequest(req)).not.toThrow();
    // server_tool_use is dropped (default branch), so no placeholder is created
    // and no tool-search name reaches the wire.
    const tools = outboundTools(req);
    expect(tools.some((t) => t.toolSpecification.name.startsWith('tool_search_tool_'))).toBe(false);
  });

  it('a history tool_use named like a marker is NOT resurrected as a placeholder tool', () => {
    // Regression guard: convertTools drops the active marker, but the downstream
    // placeholder pass must not re-add `tool_search_tool_regex` as an empty-schema
    // tool (which Kiro 400s on) just because history references that name.
    const req = baseRequest({
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'searching' },
            { type: 'tool_use', id: 'toolu_1', name: 'tool_search_tool_regex', input: {} },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
        },
        { role: 'user', content: 'now the weather?' },
      ] as MessagesRequest['messages'],
      tools: [realTools[0], regexMarker],
    });
    const tools = outboundTools(req);
    // No tool-search name on the wire — neither the active marker nor a placeholder.
    expect(tools.some((t) => t.toolSpecification.name.startsWith('tool_search_tool_'))).toBe(false);
    // The real tool is still present.
    expect(tools.some((t) => t.toolSpecification.name === 'get_weather')).toBe(true);
  });
});

describe('interleaved system-role messages (Claude Code <system-reminder> blocks)', () => {
  // Claude Code injects role:"system" reminders into messages[] (plan-mode
  // directives, tool nudges, etc.). They must reach the model, not be dropped.
  const stateOf = (messages: MessagesRequest['messages']) =>
    convertRequest(baseRequest({ model: 'claude-opus-4-8', messages }), {
      identityOverride: false,
    }).conversationState;

  const alternates = (state: ReturnType<typeof stateOf>): boolean => {
    for (let i = 1; i < state.history.length; i++) {
      if (state.history[i].kind === state.history[i - 1].kind) return false;
    }
    return true;
  };

  it('folds an interior system reminder into the preceding user turn', () => {
    const state = stateOf([
      { role: 'user', content: 'plan the refactor' },
      { role: 'system', content: 'PLAN MODE ACTIVE — call ExitPlanMode when done' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'go' },
    ] as MessagesRequest['messages']);
    expect(JSON.stringify(state)).toContain('PLAN MODE ACTIVE');
    expect(alternates(state)).toBe(true);
  });

  it('folds a trailing system reminder into the current message instead of discarding it', () => {
    const state = stateOf([
      { role: 'user', content: 'do the thing' },
      { role: 'system', content: 'REMEMBER: prefer minimal diffs' },
    ] as MessagesRequest['messages']);
    // The user message stays current; the reminder rides along with it.
    expect(state.currentMessage.userInputMessage.content).toContain('do the thing');
    expect(state.currentMessage.userInputMessage.content).toContain('prefer minimal diffs');
  });

  it('keeps a trailing system reminder alongside a tool_result current message', () => {
    const state = stateOf([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'data' }] },
      { role: 'system', content: 'SYS-REMINDER-XYZ' },
    ] as MessagesRequest['messages']);
    const cur = state.currentMessage.userInputMessage;
    expect(cur.content).toContain('SYS-REMINDER-XYZ');
    // tool_result pairing survives the fold.
    expect(cur.userInputMessageContext?.toolResults?.some((r) => r.toolUseId === 'tu1')).toBe(true);
  });

  it('prepends a leading system reminder (no preceding user) onto the next user turn', () => {
    const state = stateOf([
      { role: 'system', content: 'LEADING-REMINDER' },
      { role: 'user', content: 'hello' },
    ] as MessagesRequest['messages']);
    expect(state.currentMessage.userInputMessage.content).toContain('LEADING-REMINDER');
    expect(state.currentMessage.userInputMessage.content).toContain('hello');
  });

  it('preserves strict user/assistant alternation across multiple interleaved reminders', () => {
    const state = stateOf([
      { role: 'user', content: 'u0' },
      { role: 'system', content: 's1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'system', content: 's4' },
      { role: 'assistant', content: 'a5' },
      { role: 'user', content: 'u6' },
    ] as MessagesRequest['messages']);
    expect(alternates(state)).toBe(true);
    const dump = JSON.stringify(state);
    expect(dump).toContain('s1');
    expect(dump).toContain('s4');
  });
});

// ============================================================================
// Orphaned tool_use → synthesized tool_result
// ============================================================================
//
// 回归护栏。历史实现把未配对的 tool_use 从 history 里**删掉**以满足 Kiro 的配对
// 约束,代价是模型失忆 + 客户端零感知(收到正常 200,只有网关日志留痕)。现在改为
// 补一条 isError 的 tool_result:约束照样满足,模型看得到「这次调用被中断」。
// 生产实测该场景会固化在客户端会话里反复重发(同一 tool_use_id 跨 12 个 reqId)。

describe('convertRequest - orphaned tool_use gets a synthesized tool_result', () => {
  /** 展平 history + currentMessage 里所有 toolResults，避免断言硬编码索引。 */
  function allToolResults(state: ReturnType<typeof convertRequest>['conversationState']) {
    const out = [...state.currentMessage.userInputMessage.userInputMessageContext.toolResults];
    for (const m of state.history) {
      if (m.kind === 'user') out.push(...m.userInputMessage.userInputMessageContext.toolResults);
    }
    return out;
  }

  it('synthesizes for a partially-collected parallel tool_use (the ESC-interrupt shape)', () => {
    // assistant 并行发了两个 tool_use，客户端只回收了一个 —— 用户在第二个跑完前
    // 打断。第二个永远等不到 tool_result。
    const state = convertRequest(
      baseRequest({
        messages: [
          { role: 'user', content: 'read both files' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_done', name: 'read_file', input: { path: '/a.txt' } },
              { type: 'tool_use', id: 'toolu_cut', name: 'read_file', input: { path: '/b.txt' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_done', content: 'A' }],
          },
        ],
      }),
      { identityOverride: false },
    ).conversationState;

    const results = allToolResults(state);
    const done = results.find((r) => r.toolUseId === 'toolu_done');
    const cut = results.find((r) => r.toolUseId === 'toolu_cut');

    // 真实结果原样保留
    expect(done).toBeDefined();
    expect(done?.isError).not.toBe(true);

    // 被打断的那个补上了 isError 结果，而不是消失
    expect(cut).toBeDefined();
    expect(cut?.isError).toBe(true);
    expect(cut?.status).toBe('error');
    expect(JSON.stringify(cut?.content)).toContain(INTERRUPTED_TOOL_RESULT_TEXT);

    // ★ 核心回归点：tool_use 本身**没有**被从历史里删掉，且两个仍在**同一条**
    // assistant 上、顺序不变（比 arrayContaining 更强：那个断言在两个 tool_use 被
    // 拆到不同消息时也会通过，而那已经破坏了 Kiro 的 user/assistant 交替）。
    const assistant = state.history.find((m) => m.kind === 'assistant');
    expect(assistant?.kind).toBe('assistant');
    if (assistant?.kind === 'assistant') {
      expect(assistant.assistantResponseMessage.toolUses?.map((t) => t.toolUseId)).toEqual([
        'toolu_done',
        'toolu_cut',
      ]);
    }
  });

  it('attaches the synthesized result to the following user message when the orphan is mid-history', () => {
    // 上下文压缩裁掉了带 tool_result 的那条 user 消息：assistant 的 tool_use 后面
    // 直接跟了一条无关的 user 消息。合成结果必须挂到**那条** user 上，而不是
    // currentMessage —— 否则 tool_use 与 tool_result 跨轮次错位。
    const state = convertRequest(
      baseRequest({
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_dropped', name: 'read_file', input: { path: '/x' } },
            ],
          },
          { role: 'user', content: 'never mind, do something else' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'continue' },
        ],
      }),
      { identityOverride: false },
    ).conversationState;

    // 合成结果落在 history 里的某条 user 上，不在 currentMessage 上
    const inCurrent =
      state.currentMessage.userInputMessage.userInputMessageContext.toolResults.some(
        (r) => r.toolUseId === 'toolu_dropped',
      );
    expect(inCurrent).toBe(false);

    const inHistory = allToolResults(state).find((r) => r.toolUseId === 'toolu_dropped');
    expect(inHistory).toBeDefined();
    expect(inHistory?.isError).toBe(true);

    // 该 tool_result 必须紧跟在带它 tool_use 的 assistant 之后那条 user 上
    const idx = state.history.findIndex(
      (m) =>
        m.kind === 'assistant' &&
        (m.assistantResponseMessage.toolUses ?? []).some((t) => t.toolUseId === 'toolu_dropped'),
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = state.history[idx + 1];
    expect(next?.kind).toBe('user');
    if (next?.kind === 'user') {
      expect(
        next.userInputMessage.userInputMessageContext.toolResults.map((r) => r.toolUseId),
      ).toContain('toolu_dropped');
    }
  });

  it('keeps the orphan tool visible to tool-definition collection (placeholder still created)', () => {
    // tool_use 不再被删 → collectHistoryToolNames 仍看得见它 → 第 10 步照常补
    // placeholder 定义。上游需要这个定义才认历史里的调用。
    const state = convertRequest(
      baseRequest({
        tools: [
          {
            name: 'other_tool',
            description: 'unrelated',
            input_schema: { type: 'object', properties: {} },
          },
        ] as ClaudeTool[],
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_orphan', name: 'vanished_tool', input: {} }],
          },
          { role: 'user', content: 'nothing came back' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'next' },
        ],
      }),
      { identityOverride: false },
    ).conversationState;

    const toolNames = state.currentMessage.userInputMessage.userInputMessageContext.tools.map(
      (t) => t.toolSpecification.name,
    );
    expect(toolNames).toContain('vanished_tool');
  });

  it('synthesizes nothing when every tool_use is properly paired', () => {
    // 负向守卫：正常会话绝不能被塞进合成结果。
    const state = convertRequest(
      baseRequest({
        messages: [
          { role: 'user', content: 'read it' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_ok', name: 'read_file', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_ok', content: 'contents' }],
          },
        ],
      }),
      { identityOverride: false },
    ).conversationState;

    const synthesized = allToolResults(state).filter((r) =>
      JSON.stringify(r.content).includes(INTERRUPTED_TOOL_RESULT_TEXT),
    );
    expect(synthesized).toHaveLength(0);
  });

  it('synthesizes at most one result per tool_use_id even if the id repeats in history', () => {
    // 幂等守卫。旧的「删除 tool_use」实现天然幂等(删两遍等于删一遍);改成补齐
    // 之后,同一个 id 若出现在两条 assistant 上,逐条合成会产出两份 tool_result、
    // 挂到两条不同 user 消息上 —— 正好是本函数要消除的那类坏配对。
    const state = convertRequest(
      baseRequest({
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_dup', name: 'read_file', input: {} }],
          },
          { role: 'user', content: 'nothing came back' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_dup', name: 'read_file', input: {} }],
          },
          { role: 'user', content: 'still nothing' },
          { role: 'assistant', content: 'ok' },
          { role: 'user', content: 'continue' },
        ],
      }),
      { identityOverride: false },
    ).conversationState;

    const forDup = allToolResults(state).filter((r) => r.toolUseId === 'toolu_dup');
    expect(forDup).toHaveLength(1);
    expect(forDup[0]?.isError).toBe(true);
  });
});
