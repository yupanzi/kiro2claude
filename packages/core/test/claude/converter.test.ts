import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  convertRequest,
  IDENTITY_OVERRIDE_DIRECTIVE,
  mapModel,
  UNSUPPORTED_DOCUMENT_PLACEHOLDER,
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

describe('convertRequest - identity override', () => {
  // 断言用 .toContain(IDENTITY_OVERRIDE_DIRECTIVE)：常量改写时 import 会自动跟进，
  // 文案微调不会让测试沉默 flake。

  it('default (options omitted): system content gets identity directive appended', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: 'You are a helpful coding assistant.' }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain('You are a helpful coding assistant.');
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('identityOverride: true explicit behaves identically to default', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = convertRequest(req, { identityOverride: true });
    const head = result.conversationState.history[0];
    // 外层守卫:head 必须是 user pair。缺它时,head 丢失会让下面的 if 体被跳过,
    // Vitest 默认不对零断言用例报错 → 用例假绿、掩盖「directive 从未注入」。
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('identityOverride: false: system content has no directive', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = convertRequest(req, { identityOverride: false });
    const head = result.conversationState.history[0];
    // 外层守卫:见上一个用例的说明——无守卫时 head 丢失会让断言体静默跳过、用例假绿。
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain('You are a helpful assistant.');
      expect(head.userInputMessage.content).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('no system + default: directive injected as standalone user msg at history head', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('no system + identityOverride false + no thinking: no injected directive anywhere in history', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req, { identityOverride: false });
    // 该路径(无 system + 关身份 + 无 thinking)既不进 if 也不进 else-if,history 必为空。
    // 只对一个恒为 [] 的 history 做 not.toContain 是 vacuous——实现对错都过。先钉死 history
    // 为空(回归让 else-if 无视 identityOverride 恒触发 → length 1 → 此断言红),再确认
    // directive 既没进 history 也没泄漏到 currentMessage,才真正覆盖「完全无注入」。
    expect(result.conversationState.history).toHaveLength(0);
    const serialized = JSON.stringify(result.conversationState.history);
    expect(serialized).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    expect(result.conversationState.currentMessage.userInputMessage.content).not.toContain(
      IDENTITY_OVERRIDE_DIRECTIVE,
    );
  });

  it('empty system (text: "") + default: directive still injected, not bare', () => {
    // 回归:客户端发 system:[{text:''}] 时,过去会进 if 外层却跳过内层注入、
    // 也不落 else if,导致 identity 完全丢失。修复后空 system 等价于无 system。
    const req = baseRequest({
      system: [{ type: 'text', text: '' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('thinking + identityOverride both enabled: same user msg carries both', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
    const result = convertRequest(req, { identityOverride: true });
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain('<thinking_mode>enabled</thinking_mode>');
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('directive only in system layer, not appended to current message', () => {
    // 新契约:身份 directive 只注入 system 层(history 第一轮),近因强化已移除,
    // 当前用户消息保持客户端原文、末尾不带身份指令。回退此契约会让本断言失败。
    const req = baseRequest({
      system: [{ type: 'text', text: 'You are a helpful coding assistant.' }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req, { identityOverride: true });
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current.content).toContain('hello');
    expect(current.content).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
  });

  // --------------------------------------------------------------------------
  // 退化输入边界:hi / 空请求 / 空 system —— 身份覆写在最小/空载请求下仍须成立。
  // 这三组与 e2e live.test.ts 的同名身份回归一一对应:单元层只钉「directive 被
  // 注入到 system 层」,e2e 层才钉「真实模型不泄漏后端身份」(3b 注释的分工)。
  // --------------------------------------------------------------------------

  it('minimal "hi" greeting (no system, default): directive at head, current msg verbatim', () => {
    const req = baseRequest({ messages: [{ role: 'user', content: 'hi' }] });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
    // current message 保持客户端原文 'hi',末尾不带身份指令(directive 只落 system 层)。
    const current = result.conversationState.currentMessage.userInputMessage;
    expect(current.content).toBe('hi');
    expect(current.content).not.toContain(IDENTITY_OVERRIDE_DIRECTIVE);
  });

  it('empty request (user content ""): no throw, directive still at head, current empty', () => {
    // 空 content 不抛 EmptyMessages —— 那个守卫只挡 messages 数组为空。current message
    // 文本退化为空串,但身份 directive 仍由 else-if 分支注入到 history 头。
    const req = baseRequest({ messages: [{ role: 'user', content: '' }] });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe('');
  });

  it('empty request (user content []): no throw, directive still at head, current empty', () => {
    const req = baseRequest({ messages: [{ role: 'user', content: [] }] });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
    expect(result.conversationState.currentMessage.userInputMessage.content).toBe('');
  });

  it('empty system wire "" → preprocessSystem normalizes to [{text:""}], directive still injected', () => {
    // 客户端发 system:"" (空字符串)。handler 经 messagesRequestSchema → preprocessSystem
    // 归一成 [{text:""}](与已覆盖的 system:[{text:""}] 同形)→ buildHistory 空 systemContent
    // → else-if 仍注入身份。这条链同时钉住归一规则 + 身份不丢。
    const normalized = preprocessSystem('');
    expect(normalized).toEqual([{ text: '' }]);
    const req = baseRequest({ system: normalized, messages: [{ role: 'user', content: 'hi' }] });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('empty system wire [] → preprocessSystem normalizes to undefined, directive still injected', () => {
    // 空数组被 preprocessSystem 丢成 undefined(等价「无 system」)→ else-if 仍注入身份。
    const normalized = preprocessSystem([]);
    expect(normalized).toBeUndefined();
    const req = baseRequest({ system: normalized, messages: [{ role: 'user', content: 'hi' }] });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain(IDENTITY_OVERRIDE_DIRECTIVE);
    }
  });

  it('with-system branch: identity directive appended after system with a blank-line separator', () => {
    // byte 级钉死 if(systemContent) 分支的形态与顺序:客户端 system 原文 + 空行 + 身份指令。
    // 该分支曾在 system 与 directive 之间夹一段 chunked-write policy;该 policy 已移除后,
    // 形态收敛为 `${system}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}`(无中间夹层),故直接用整串
    // toBe 精确钉(强于历史的 endsWith/startsWith):把 \n\n 改回单 \n、挪走 directive、
    // 或重新引入 system 后的夹层内容都会变红。baseRequest 为非原生 reasoning 且未启用
    // thinking,故无 `<thinking_mode>` 前缀注入。
    const systemText = 'You are a helpful coding assistant.';
    const req = baseRequest({
      system: [{ type: 'text', text: systemText }],
      messages: [{ role: 'user', content: 'hello' }],
    });
    const result = convertRequest(req, { identityOverride: true });
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toBe(`${systemText}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}`);
    }
  });
});

describe('convertRequest - thinking prefix injection', () => {
  // 请求侧 `<thinking_mode>` 注入的回归覆盖(与身份覆写正交,这里只钉 thinking)。
  // baseRequest 的 claude-sonnet-4 非原生 reasoning,故 thinking 走 prompt 前缀注入路径。

  it('thinking enabled (no system): thinking_mode prefix injected at history head', () => {
    const req = baseRequest({
      messages: [{ role: 'user', content: 'hello' }],
      thinking: { type: 'enabled', budget_tokens: 8000 },
    });
    const result = convertRequest(req);
    const head = result.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain('<thinking_mode>enabled</thinking_mode>');
    }
  });

  it('empty system (text: "") + thinking: treated as no-system, no empty system shell', () => {
    // 回归:converter.ts 的 system 存在判断基于「拼接后的 systemContent 真值」而非
    // `req.system` 数组长度。客户端发 `system:[{text:''}]`(数组非空、内容空)必须等价于
    // 「无 system」,走 else 分支(thinking + identity),而不是走 if 分支拼出一个带
    // 多余前导空行的畸形 system(`\n\n`+identity)。用「与无 system 的结果逐字节相等」钉死它:
    // 若有人把判断改回 `req.system?.length`,空 system 会走 system 分支、与无 system
    // 分支产物发散 ⇒ 此处 toEqual 失败。
    const thinking = { type: 'enabled' as const, budget_tokens: 8000 };
    const withEmptySystem = convertRequest(
      baseRequest({
        system: [{ type: 'text', text: '' }],
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
      }),
    );
    const withNoSystem = convertRequest(
      baseRequest({
        messages: [{ role: 'user', content: 'hi' }],
        thinking,
      }),
    );
    expect(withEmptySystem.conversationState.history).toEqual(
      withNoSystem.conversationState.history,
    );

    // 正向:history 头部带 thinking 前缀(确实注入了),且未退化成空 system 壳。
    const head = withEmptySystem.conversationState.history[0];
    expect(head?.kind).toBe('user');
    if (head?.kind === 'user') {
      expect(head.userInputMessage.content).toContain('<thinking_mode>enabled</thinking_mode>');
    }
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
