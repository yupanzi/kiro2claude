/**
 * Claude -> Kiro protocol converter
 *
 * Converts Claude API request format to Kiro API request format.
 */

import { validate as isValidUuid, v4 as uuidv4 } from 'uuid';
import { getKiroClientProfile, renderOperatingSystem } from '../kiro/client-profile.js';
import type {
  ConversationState,
  CurrentMessage,
  EffortLevel,
  KiroImage,
  Message as KiroMessage,
  UserInputMessage,
  UserInputMessageContext,
} from '../kiro/model/requests/conversation.js';
import {
  createAssistantMessage,
  createKiroImage,
  createUserInputMessage,
  createUserMessage,
} from '../kiro/model/requests/conversation.js';
import type { Tool as KiroTool, ToolResult, ToolUseEntry } from '../kiro/model/requests/tool.js';
import {
  createToolUseEntry,
  toolResultError,
  toolResultSuccess,
} from '../kiro/model/requests/tool.js';
import { getLogger } from '../shared/logger.js';
import { mapToolName } from './converter/tool-name-map.js';
import { ToolCallTextStripper, type ToolTextRegistry } from './tool-call-text.js';

import type { Message as ClaudeMessage, ContentBlock, MessagesRequest, Tool } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Pins the model's self-identity to Claude / Anthropic, overriding any
 * upstream-injected "You are Q" prompts from Kiro / AWS CodeWhisperer.
 * Placed at the end of system content so it takes precedence over earlier
 * conflicting directives. Toggled by `KIRO2CLAUDE_IDENTITY_OVERRIDE`.
 */
export const IDENTITY_OVERRIDE_DIRECTIVE = `Identity directive: You are Claude, made by Anthropic.`;

/**
 * Text substituted for an unsupported `document` content block (e.g. a PDF that
 * Claude Code's Read tool returns as a base64 document) when
 * `rejectUnsupportedDocuments` is on. The upstream has no document channel, so
 * the bytes can't be forwarded; silently dropping them makes the model
 * hallucinate an answer about a file it never saw. Leaving this neutral,
 * actionable note instead lets the downstream agent (e.g. Claude Code) notice
 * the failure and extract the text itself, then resend it as plain text.
 * Phrased to name no upstream backend (leak-safe — says "this service").
 */
export const UNSUPPORTED_DOCUMENT_PLACEHOLDER =
  '[A document was attached here (e.g. a PDF), but this service cannot read document/PDF content blocks, ' +
  'so it was not delivered to the model. If its contents matter, extract the text yourself ' +
  '(e.g. via a shell tool like `pdftotext`, or a PDF/Office parsing library) and resend it as plain text.]';

/** Kiro API max tool name length */
// TOOL_NAME_MAX_LEN / shortenToolName / mapToolName live in ./converter/tool-name-map.ts
// so the 63-char upstream cap has exactly one source of truth. Re-imported above
// for use by convertTools().

// ============================================================================
// Model mapping
// ============================================================================

/**
 * Map Claude / OpenAI model name to Kiro model ID.
 *
 * - sonnet 5/sonnet-5 -> claude-sonnet-5
 * - sonnet 4.6/4-6 -> claude-sonnet-4.6
 * - other sonnet -> claude-sonnet-4.5
 * - opus 4.5/4-5 -> claude-opus-4.5
 * - opus 4.7/4-7 -> claude-opus-4.7
 * - opus 4.8/4-8 -> claude-opus-4.8
 * - other opus -> claude-opus-4.6 (fallback)
 * - all haiku -> claude-haiku-4.5
 * - gpt … sol/terra/luna -> gpt-5.6-{sol,terra,luna}
 *
 * GPT-5.6（OpenAI，kiro-cli 2.12.1 起）走与 Claude **完全相同**的上游
 * conversationState wire，唯一差异就是这里映射出的 modelId。判别子用唯一
 * token（sol/terra/luna）而非完整串，兼容 `gpt-5.6-sol` / `gpt-5-6-sol` /
 * 任意大小写 / OpenAI 端点回显的原始 model 名。未知 gpt 变体返回 undefined
 * → 400 UnsupportedModel（不把不存在的模型静默转发上游）。
 */
export function mapModel(model: string): string | undefined {
  const lower = model.toLowerCase();

  if (lower.includes('sonnet')) {
    // 'sonnet-5' 边界匹配: 'claude-sonnet-4-5' 含 'sonnet-4-5' 而非 'sonnet-5',不会误伤
    if (lower.includes('sonnet-5')) {
      return 'claude-sonnet-5';
    }
    if (lower.includes('4-6') || lower.includes('4.6')) {
      return 'claude-sonnet-4.6';
    }
    return 'claude-sonnet-4.5';
  }
  if (lower.includes('opus')) {
    if (lower.includes('4-5') || lower.includes('4.5')) {
      return 'claude-opus-4.5';
    }
    if (lower.includes('4-7') || lower.includes('4.7')) {
      return 'claude-opus-4.7';
    }
    if (lower.includes('4-8') || lower.includes('4.8')) {
      return 'claude-opus-4.8';
    }
    return 'claude-opus-4.6';
  }
  if (lower.includes('haiku')) {
    return 'claude-haiku-4.5';
  }
  if (lower.includes('gpt')) {
    if (lower.includes('sol')) return 'gpt-5.6-sol';
    if (lower.includes('terra')) return 'gpt-5.6-terra';
    if (lower.includes('luna')) return 'gpt-5.6-luna';
    // Codex CLI 别名:Codex 只对它**内部识别**的模型名下发工具集(实测
    // gpt-5.6-sol→0 工具 / gpt-5-codex→10 工具)。所以走 Codex 且要工具调用时,
    // config.toml 必须用 `gpt-5-codex` 这类名字;网关把它们别名到 GPT-5.6 旗舰
    // (sol),让 Codex 工具调用端到端可用。想换档在 Codex 端改不了(会丢工具),
    // 只能改这里的别名目标。
    if (lower.includes('codex')) return 'gpt-5.6-sol';
    return undefined;
  }
  return undefined;
}

// ============================================================================
// Native reasoning support (kiro-cli 2.6.0+)
// ============================================================================

/**
 * Mapped Kiro modelId 的集合，这些 model 在 kiro 后端原生支持
 * `userInputMessage.reasoning.effort` wire 字段。其它 model 走
 * `<thinking_mode>` prompt 注入路径（fallback）。
 *
 * 实测：4.7 完全响应 effort（max → low reasoning chunk 数 3.4× 变化）；
 * 4.8 effort 暂不分档但 reasoning 默认开启；
 * 4.6 / sonnet / haiku / 4.5 完全不支持（加 reasoning 字段被静默忽略）。
 *
 * GPT-5.6 系列同样走原生 `reasoning.effort`（kiro-cli settings 的
 * `chat.modelDefaults` 为 gpt-5.6-sol 存了 reasoning.effort，真实请求确认生效）。
 * 但 GPT 的 reasoning 内容是**加密的**：上游用同名 `reasoningContentEvent` 回
 * `{redactedContent}`（无 text/signature），无内容可 surface——见 stream.ts
 * `processReasoningContent` 的 redacted 守卫。放进本集合只为触发请求侧 effort
 * 注入 + 跳过 `<thinking>` prompt 前缀，与响应侧是否有可用 thinking 无关。
 */
export const MODELS_WITH_NATIVE_REASONING: ReadonlySet<string> = new Set([
  'claude-opus-4.7',
  'claude-opus-4.8',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

/**
 * 把 Anthropic Extended Thinking 的 `thinking` + `output_config` 映射成
 * kiro-cli 的 `reasoning.effort` 等级。
 *
 * 双通道：
 *   - `type === 'adaptive'`: 直接同步 `output_config.effort`（缺省 'high'）。
 *     语义最清晰——下游想精确控制 effort 等级就用这条。
 *   - `type === 'enabled'`: 按 `budget_tokens` 阈值映射。下游用 Anthropic
 *     原始 wire format 时走这条。阈值参考 Anthropic budget_tokens 常用值
 *     1024-32768 等分。
 *   - 其它: 返回 undefined（不传 reasoning 字段，走 baseline）。
 */
export function mapThinkingToEffort(
  thinking: { type: string; budget_tokens?: number } | undefined,
  outputConfig: { effort?: string } | undefined,
): EffortLevel | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'adaptive') {
    const effort = outputConfig?.effort ?? 'high';
    if (isEffortLevel(effort)) return effort;
    return 'high';
  }
  if (thinking.type === 'enabled') {
    const bt = thinking.budget_tokens ?? 20000;
    if (bt < 2048) return 'low';
    if (bt < 8192) return 'medium';
    if (bt < 16384) return 'high';
    if (bt < 32768) return 'xhigh';
    return 'max';
  }
  return undefined;
}

function isEffortLevel(s: string): s is EffortLevel {
  return s === 'low' || s === 'medium' || s === 'high' || s === 'xhigh' || s === 'max';
}

/** model 是否走原生 reasoning 路径（wire 字段 `reasoning.effort`） */
export function usesNativeReasoning(mappedModelId: string): boolean {
  return MODELS_WITH_NATIVE_REASONING.has(mappedModelId);
}

/**
 * 客户端模型名(**未映射**)是否走**加密 reasoning** 原生路径(GPT-5.6 系列:
 * reasoning 内容 redacted,上游不给明文/signature)。先 mapModel 再判。
 *
 * handler 侧据此在计算 `extractThinking` 时关掉 legacy `<thinking>` 扫描:GPT 的
 * reasoningContentEvent 被 `processReasoningContent` 的 `if(!text&&!signature)` 守卫
 * 丢弃,**不会**置 `sawReasoningContent`,故运行时信号无法关闭扫描——必须靠此静态
 * 判定关掉,否则 GPT 可见输出里的字面 `<thinking>` 会被误当思维链剥离。
 *
 * ⚠ **仅限 GPT**:Claude 原生 reasoning(4.7/4.8)是**明文**,靠运行时
 * `sawReasoningContent` 关闭扫描,且**必须** `thinkingEnabled=true` 才能维持
 * thinking→text 的 content block 顺序(`generateInitialEvents` 在 thinkingEnabled=false
 * 时会提前开 text block,把 thinking block 挤到其后——实测 e2e 流式顺序断言失败)。
 * 所以绝不能把 Claude 原生模型纳入此判定。未知模型 → false(convertRequest 已先拒)。
 */
export function clientModelHasEncryptedReasoning(clientModel: string): boolean {
  return mapModel(clientModel)?.startsWith('gpt') ?? false;
}

/**
 * Get context window size for a model.
 *
 * Kiro upgraded Opus 4.6 and Sonnet 4.6 to 1M context on 2026-03-24.
 * Opus 4.7 and 4.8 also ship with the 1M window (上游 list-models 实测确认).
 * Sonnet 5 同为 1M context (Anthropic 官方规格,与前代 Sonnet 4.6 一致).
 * GPT-5.6 系列为 272K context (上游 `--list-models` 实测: context_window_tokens 272000).
 */
export function getContextWindowSize(model: string): number {
  const mapped = mapModel(model);
  if (
    mapped === 'claude-sonnet-4.6' ||
    mapped === 'claude-sonnet-5' ||
    mapped === 'claude-opus-4.6' ||
    mapped === 'claude-opus-4.7' ||
    mapped === 'claude-opus-4.8'
  ) {
    return 1_000_000;
  }
  if (mapped === 'gpt-5.6-sol' || mapped === 'gpt-5.6-terra' || mapped === 'gpt-5.6-luna') {
    return 272_000;
  }
  return 200_000;
}

/**
 * Resolve a `ContextUsage` frame's percentage into a concrete input-token
 * count and a window-exceeded flag. Shared by the streaming and non-streaming
 * handlers so the percentage→tokens math and the 100% threshold live in one
 * place instead of being copy-pasted into both.
 */
export function resolveContextUsage(
  model: string,
  contextUsagePercentage: number,
): { inputTokens: number; exceeded: boolean } {
  const windowSize = getContextWindowSize(model);
  return {
    inputTokens: Math.floor((contextUsagePercentage * windowSize) / 100.0),
    exceeded: contextUsagePercentage >= 100.0,
  };
}

// ============================================================================
// Conversion result and errors
// ============================================================================

export interface ConversionResult {
  conversationState: ConversationState;
  /** Tool name mapping (short name -> original name) */
  toolNameMap: Map<string, string>;
}

export interface ConvertRequestOptions {
  /** 默认 true。详见 `Config.identityOverride`。 */
  identityOverride?: boolean;
  /**
   * 默认 false（库函数保守默认，保持向后兼容的"静默丢弃"行为）。生产路径由
   * handler 从 `Config.rejectUnsupportedDocuments`（默认 true）显式传入。开启
   * 后，`document` 块在转换前被替换成文本占位提示，而不是被静默丢弃。
   */
  rejectUnsupportedDocuments?: boolean;
  /**
   * Tool `description` 的最大长度(code points),超出则截断并 warn。默认
   * `DEFAULT_TOOL_DESCRIPTION_MAX_LEN`(32K)。生产路径由 handler 从
   * `Config.toolDescriptionMaxLen` 传入;为何是 32K(context-window 而非单 description
   * 上限)见该常量头注释与 `Config.toolDescriptionMaxLen`。
   */
  toolDescriptionMaxLen?: number;
  /**
   * 泄漏工具调用文本的注册表（本次请求注册的工具 → 参数类型）。**存在即启用**
   * 请求侧历史去污染：assistant 历史文本里泄漏的工具调用标记块（见
   * tool-call-text.ts 文件头）在上送前被剥掉——阻断「模型模仿历史里的坏格式
   * → 同一会话确定性复发」的自我污染循环，让已污染的会话自愈。由 handler 透传
   * **响应侧已构建的同一注册表**（见 handlers.ts），避免每请求重复构建。默认
   * undefined（库函数保守默认，不去污染）。
   */
  toolTextRegistry?: ToolTextRegistry;
}

export class ConversionError extends Error {
  constructor(
    public readonly code: 'UnsupportedModel' | 'EmptyMessages',
    message: string,
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}

// ============================================================================
// JSON Schema normalization
// ============================================================================

/**
 * Normalize JSON Schema, fixing common issues from MCP tool definitions.
 *
 * Claude Code / MCP occasionally produces `required: null`, `properties: null`, etc.
 * causing upstream 400 "Improperly formed request".
 */
function normalizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    };
  }

  const obj = { ...(schema as Record<string, unknown>) };

  // type (must be string)
  if (typeof obj.type !== 'string' || !(obj.type as string)) {
    obj.type = 'object';
  }

  // properties (must be object)
  if (!obj.properties || typeof obj.properties !== 'object' || Array.isArray(obj.properties)) {
    obj.properties = {};
  }

  // required (must be string array)
  if (Array.isArray(obj.required)) {
    obj.required = obj.required.filter((v: unknown) => typeof v === 'string');
  } else {
    obj.required = [];
  }

  // additionalProperties (allow bool or object, otherwise default to true)
  if (
    typeof obj.additionalProperties !== 'boolean' &&
    (typeof obj.additionalProperties !== 'object' || obj.additionalProperties === null)
  ) {
    obj.additionalProperties = true;
  }

  return obj;
}

// ============================================================================
// Session ID extraction
// ============================================================================

/**
 * Extract session UUID from metadata.user_id.
 *
 * Supports two formats:
 * 1. String: user_xxx_account__session_00000000-0000-4000-8000-000000000000
 * 2. JSON: {"device_id":"...","account_uuid":"...","session_id":"UUID"}
 */
function extractSessionId(userId: string): string | undefined {
  // Try JSON first
  try {
    const json = JSON.parse(userId);
    if (json?.session_id && typeof json.session_id === 'string' && isValidUuid(json.session_id)) {
      return json.session_id;
    }
  } catch {
    // Not JSON, try string format
  }

  // Fallback to string format: find "session_" followed by UUID
  const idx = userId.indexOf('session_');
  if (idx >= 0) {
    const sessionPart = userId.slice(idx + 8); // "session_".length = 8
    if (sessionPart.length >= 36) {
      const uuidStr = sessionPart.slice(0, 36);
      if (isValidUuid(uuidStr)) {
        return uuidStr;
      }
    }
  }
  return undefined;
}

// ============================================================================
// Tool conversion
// ============================================================================

/**
 * Anthropic tool-search beta tool `type` values (dated 20251119). A client that
 * opts into tool-search sends one synthetic tool of this type plus real tools
 * flagged `defer_loading`. These marker tools have no `input_schema` and are
 * meant to be handled server-side; Kiro has no equivalent, so we drop them in
 * `convertTools` rather than forwarding a degenerate empty-schema tool upstream.
 */
const TOOL_SEARCH_TOOL_TYPES: ReadonlySet<string> = new Set([
  'tool_search_tool_regex_20251119',
  'tool_search_tool_bm25_20251119',
]);

/**
 * Tool-search marker tools conventionally NAME themselves with this prefix
 * (e.g. `tool_search_tool_regex`). The active-tool drop in `convertTools` keys
 * on `type`, but history only carries tool `name`, so the placeholder pass uses
 * this prefix to avoid resurrecting a dropped marker as a degenerate
 * empty-schema placeholder tool (which Kiro rejects with HTTP 400).
 */
const TOOL_SEARCH_TOOL_NAME_PREFIX = 'tool_search_tool_';

function isToolSearchTool(tool: Tool): boolean {
  return tool.type !== undefined && TOOL_SEARCH_TOOL_TYPES.has(tool.type);
}

/**
 * Default cap for tool `description` length (code points) = 32K (32768). NOT a
 * per-description Kiro limit — a SINGLE tool description can be arbitrarily large
 * (far beyond anything a real tool needs) and upstream still accepts it (200 OK);
 * the real constraint is the shared CONTEXT WINDOW: many tools + long history +
 * system together overflowing that window return HTTP 400 "Context window is full"
 * (reproducible once enough oversized tools are stacked together). 32K comfortably
 * covers the largest known legitimate tool (Workflow) with headroom to spare while
 * stopping one pathological description from eating the window. Override via
 * KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN.
 */
const DEFAULT_TOOL_DESCRIPTION_MAX_LEN = 32_768;

function convertTools(
  tools: Tool[] | undefined,
  toolNameMap: Map<string, string>,
  maxDescriptionLen: number,
): KiroTool[] {
  if (!tools) return [];

  const result: KiroTool[] = [];
  for (const t of tools) {
    // Anthropic tool-search beta (dated 20251119): the client sends a synthetic
    // `tool_search_tool_{regex,bm25}` entry that carries no input_schema and is
    // meant to be resolved server-side. Kiro has no tool-search, so forwarding it
    // as an ordinary tool yields a degenerate empty-schema tool that Kiro rejects
    // with HTTP 400 (verified against live upstream). Drop the marker tool.
    // `defer_loading` on real tools is intentionally NOT honored: we forward every
    // real tool with its full schema (no deferral), which Kiro accepts normally.
    if (isToolSearchTool(t)) continue;

    let description = t.description ?? '';

    // Cap tool description length so one pathological description can't eat the
    // shared context window (why 32K, and why this is NOT a per-description Kiro
    // limit: see the DEFAULT_TOOL_DESCRIPTION_MAX_LEN header).
    // UTF-16 .length is always >= the code-point count, so the cheap check skips
    // the common case without materializing a code-point array for every tool.
    // Warn so the truncation stays observable rather than silent.
    if (description.length > maxDescriptionLen) {
      const chars = [...description];
      if (chars.length > maxDescriptionLen) {
        getLogger().warn({
          msg: 'tool description truncated to configured cap',
          tool_name: t.name,
          original_len: chars.length,
          cap: maxDescriptionLen,
        });
        description = chars.slice(0, maxDescriptionLen).join('');
      }
    }

    result.push({
      toolSpecification: {
        name: mapToolName(t.name, toolNameMap),
        description,
        inputSchema: {
          json: normalizeJsonSchema(t.input_schema),
        },
      },
    });
  }
  return result;
}

// ============================================================================
// Placeholder tool for history-referenced tools
// ============================================================================

function createPlaceholderTool(name: string): KiroTool {
  return {
    toolSpecification: {
      name,
      description: 'Tool used in conversation history',
      inputSchema: {
        json: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: true,
        },
      },
    },
  };
}

// ============================================================================
// Message content processing
// ============================================================================

interface ProcessedContent {
  text: string;
  images: KiroImage[];
  toolResults: ToolResult[];
}

/**
 * Process message content, extracting text, images, and tool results.
 *
 * `rejectUnsupportedDocuments` controls what happens to content-bearing blocks
 * the upstream has no channel for (e.g. a `document`/PDF): when on, a neutral
 * text placeholder is left in their place so the model knows something
 * unreadable was attached; when off, they are dropped. Either way it is logged.
 */
function processMessageContent(
  content: unknown,
  rejectUnsupportedDocuments: boolean,
): ProcessedContent {
  const textParts: string[] = [];
  const images: KiroImage[] = [];
  const toolResults: ToolResult[] = [];

  if (typeof content === 'string') {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as ContentBlock;

      switch (block.type) {
        case 'text':
          if (block.text) {
            textParts.push(block.text);
          }
          break;

        case 'image': {
          const image = extractImageBlock(block, 'message');
          if (image) images.push(image);
          break;
        }

        case 'tool_result':
          if (block.tool_use_id) {
            const { text: resultText, images: resultImages } = extractToolResultContent(
              block.content,
              rejectUnsupportedDocuments,
            );
            // Hoist any images embedded in the tool result up to the message-level
            // `images` array. Kiro's ToolResult wire format only carries text, so an
            // image left inside the tool result would be silently dropped and the
            // model would never see it (e.g. Claude Code's Read tool returns large
            // images as a tool_result image block).
            images.push(...resultImages);
            const isError = block.is_error ?? false;

            const result: ToolResult = isError
              ? toolResultError(block.tool_use_id, resultText)
              : toolResultSuccess(block.tool_use_id, resultText);
            toolResults.push(result);
          }
          break;

        case 'tool_use':
          // Handled in assistant messages, ignored here
          break;

        default:
          // Unhandled content-bearing types (e.g. `document`/PDF) have no
          // upstream channel. Leave a placeholder (or drop) per the flag, and
          // warn either way so it's diagnosable instead of a mysterious
          // empty/wrong response.
          if (rejectUnsupportedDocuments) {
            textParts.push(UNSUPPORTED_DOCUMENT_PLACEHOLDER);
            getLogger().warn({
              msg: 'replacing unsupported content block with placeholder',
              block_type: block.type,
            });
          } else {
            getLogger().warn({ msg: 'dropping unsupported content block', block_type: block.type });
          }
          break;
      }
    }
  }

  return {
    text: textParts.join('\n'),
    images,
    toolResults,
  };
}

/** Get image format from media_type */
function getImageFormat(mediaType: string): string | undefined {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpeg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return undefined;
  }
}

/**
 * Decode an `image` content block into a `KiroImage`, or warn and return
 * `undefined` when its media_type has no Kiro vision channel.
 *
 * Single source of truth for the two content walkers that handle image blocks
 * (`processMessageContent` and `extractToolResultContent`); they differ only in
 * the warn `origin` and whether they emit a textual placeholder alongside the
 * hoisted image — neither of which belongs in the decode logic.
 */
function extractImageBlock(
  block: ContentBlock,
  origin: 'message' | 'tool_result',
): KiroImage | undefined {
  if (!block.source) return undefined;
  const format = getImageFormat(block.source.media_type);
  if (format) {
    return createKiroImage(format, block.source.data);
  }
  // Silent drops here are invisible "no response" causes — surface them.
  getLogger().warn({
    msg: 'dropping image with unsupported media_type',
    origin,
    media_type: block.source.media_type,
  });
  return undefined;
}

/**
 * Extract tool result content.
 *
 * Text stays in the tool result; any image blocks are pulled out into `images`
 * so the caller can hoist them to the message level (Kiro tool results carry
 * text only — see the `tool_result` case in `processMessageContent`). When a
 * tool result contains only an image, a short textual placeholder is emitted so
 * the result isn't empty and the model can correlate it with the attached image.
 */
function extractToolResultContent(
  content: unknown,
  rejectUnsupportedDocuments: boolean,
): { text: string; images: KiroImage[] } {
  const images: KiroImage[] = [];

  if (typeof content === 'string') return { text: content, images };

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as ContentBlock;

      if (block.type === 'image') {
        const image = extractImageBlock(block, 'tool_result');
        if (image) {
          images.push(image);
          parts.push('[image attached to this message]');
        }
        continue;
      }

      if (typeof block.text === 'string') {
        parts.push(block.text);
        continue;
      }

      // Anything else in a tool result (e.g. a `document` block) has no upstream
      // channel. Same placeholder-or-drop policy as the message-level walker.
      if (rejectUnsupportedDocuments) {
        parts.push(UNSUPPORTED_DOCUMENT_PLACEHOLDER);
        getLogger().warn({
          msg: 'replacing unsupported tool_result content block with placeholder',
          block_type: block.type,
        });
      } else {
        getLogger().warn({
          msg: 'dropping unsupported tool_result content block',
          block_type: block.type,
        });
      }
    }
    return { text: parts.join('\n'), images };
  }

  if (content !== undefined && content !== null) {
    return { text: JSON.stringify(content), images };
  }

  return { text: '', images };
}

// ============================================================================
// Tool pairing validation
// ============================================================================

/**
 * Validate tool_use / tool_result pairing.
 *
 * Returns: [filtered tool results, orphaned tool_use IDs]
 */
function validateToolPairing(
  history: KiroMessage[],
  toolResults: ToolResult[],
): [ToolResult[], Set<string>] {
  const allToolUseIds = new Set<string>();
  const historyToolResultIds = new Set<string>();

  for (const msg of history) {
    if (msg.kind === 'assistant') {
      const toolUses = msg.assistantResponseMessage.toolUses;
      if (toolUses) {
        for (const tu of toolUses) {
          allToolUseIds.add(tu.toolUseId);
        }
      }
    } else if (msg.kind === 'user') {
      for (const result of msg.userInputMessage.userInputMessageContext.toolResults) {
        historyToolResultIds.add(result.toolUseId);
      }
    }
  }

  // Compute truly unpaired tool_use IDs
  const unpairedToolUseIds = new Set<string>();
  for (const id of allToolUseIds) {
    if (!historyToolResultIds.has(id)) {
      unpairedToolUseIds.add(id);
    }
  }

  // Filter and validate current message's tool_results
  const filteredResults: ToolResult[] = [];

  for (const result of toolResults) {
    if (unpairedToolUseIds.has(result.toolUseId)) {
      // Paired successfully
      filteredResults.push(result);
      unpairedToolUseIds.delete(result.toolUseId);
    } else if (allToolUseIds.has(result.toolUseId)) {
      // Duplicate tool_result - already paired in history
      getLogger().warn(
        `Skipping duplicate tool_result: tool_use already paired in history, tool_use_id=${result.toolUseId}`,
      );
    } else {
      // Orphaned tool_result - no corresponding tool_use
      getLogger().warn(
        `Skipping orphaned tool_result: no corresponding tool_use, tool_use_id=${result.toolUseId}`,
      );
    }
  }

  // Log orphaned tool_uses
  for (const orphanedId of unpairedToolUseIds) {
    getLogger().warn(
      `Detected orphaned tool_use: no corresponding tool_result, will remove from history, tool_use_id=${orphanedId}`,
    );
  }

  return [filteredResults, unpairedToolUseIds];
}

/**
 * Remove orphaned tool_uses from history.
 *
 * Kiro API requires each tool_use to have a corresponding tool_result.
 */
function removeOrphanedToolUses(history: KiroMessage[], orphanedIds: Set<string>): void {
  if (orphanedIds.size === 0) return;

  for (const msg of history) {
    if (msg.kind === 'assistant') {
      const am = msg.assistantResponseMessage;
      if (am.toolUses) {
        const originalLen = am.toolUses.length;
        am.toolUses = am.toolUses.filter((tu) => !orphanedIds.has(tu.toolUseId));

        if (am.toolUses.length === 0) {
          am.toolUses = undefined;
        } else if (am.toolUses.length !== originalLen) {
          getLogger().debug(
            `Removed ${originalLen - am.toolUses.length} orphaned tool_use(s) from assistant message`,
          );
        }
      }
    }
  }
}

// ============================================================================
// Collect history tool names
// ============================================================================

function collectHistoryToolNames(history: KiroMessage[]): Set<string> {
  const seen = new Set<string>();

  for (const msg of history) {
    if (msg.kind === 'assistant') {
      const toolUses = msg.assistantResponseMessage.toolUses;
      if (toolUses) {
        for (const tu of toolUses) {
          seen.add(tu.name);
        }
      }
    }
  }

  return seen;
}

// ============================================================================
// Thinking prefix generation
// ============================================================================

function generateThinkingPrefix(req: MessagesRequest): string | undefined {
  if (req.thinking) {
    if (req.thinking.type === 'enabled') {
      return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${req.thinking.budget_tokens}</max_thinking_length>`;
    }
    if (req.thinking.type === 'adaptive') {
      const effort = req.output_config?.effort ?? 'high';
      return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`;
    }
  }
  return undefined;
}

function hasThinkingTags(content: string): boolean {
  return content.includes('<thinking_mode>') || content.includes('<max_thinking_length>');
}

// ============================================================================
// Assistant message conversion
// ============================================================================

function convertAssistantMessage(
  msg: ClaudeMessage,
  toolNameMap: Map<string, string>,
): KiroMessage {
  let thinkingContent = '';
  let textContent = '';
  const toolUses: ToolUseEntry[] = [];

  if (typeof msg.content === 'string') {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const item of msg.content) {
      if (!item || typeof item !== 'object') continue;
      const block = item as ContentBlock;

      switch (block.type) {
        case 'thinking':
          if (block.thinking) {
            thinkingContent += block.thinking;
          }
          break;
        case 'text':
          if (block.text) {
            textContent += block.text;
          }
          break;
        case 'tool_use':
          if (block.id && block.name) {
            const input = block.input ?? {};
            const mappedName = mapToolName(block.name, toolNameMap);
            toolUses.push(createToolUseEntry(block.id, mappedName, input));
          }
          break;
        default:
          break;
      }
    }
  }

  // Combine thinking and text content
  // Format: <thinking>thinking_content</thinking>\n\ntext_content
  // Note: Kiro API requires content field to be non-empty; when only tool_use, use placeholder
  let finalContent: string;
  if (thinkingContent) {
    if (textContent) {
      finalContent = `<thinking>${thinkingContent}</thinking>\n\n${textContent}`;
    } else {
      finalContent = `<thinking>${thinkingContent}</thinking>`;
    }
  } else if (!textContent && toolUses.length > 0) {
    finalContent = ' ';
  } else {
    finalContent = textContent;
  }

  const assistant = createAssistantMessage(finalContent);
  if (toolUses.length > 0) {
    assistant.toolUses = toolUses;
  }

  return {
    kind: 'assistant',
    assistantResponseMessage: assistant,
  };
}

/** Merge multiple consecutive assistant messages into one */
function mergeAssistantMessages(
  messages: ClaudeMessage[],
  toolNameMap: Map<string, string>,
): KiroMessage {
  if (messages.length === 1) {
    return convertAssistantMessage(messages[0], toolNameMap);
  }

  const allToolUses: ToolUseEntry[] = [];
  const contentParts: string[] = [];

  for (const msg of messages) {
    const converted = convertAssistantMessage(msg, toolNameMap);
    if (converted.kind !== 'assistant') continue;
    const am = converted.assistantResponseMessage;
    if (am.content.trim()) {
      contentParts.push(am.content);
    }
    if (am.toolUses) {
      allToolUses.push(...am.toolUses);
    }
  }

  // Kiro 要求 content 非空。无文本内容时一律用单空格占位——不论是「只有
  // toolUses」还是「各条都被上面的 .trim() 丢成空」(如去污染把连续 assistant
  // 全剥成占位 ' ')。后者若落到 [].join('\n\n') 会产出空 content 上送 Kiro。
  const content = contentParts.length === 0 ? ' ' : contentParts.join('\n\n');

  const assistant = createAssistantMessage(content);
  if (allToolUses.length > 0) {
    assistant.toolUses = allToolUses;
  }

  return {
    kind: 'assistant',
    assistantResponseMessage: assistant,
  };
}

/** Merge multiple user messages */
function mergeUserMessages(
  messages: ClaudeMessage[],
  modelId: string,
  rejectUnsupportedDocuments: boolean,
): KiroMessage {
  const contentParts: string[] = [];
  const allImages: KiroImage[] = [];
  const allToolResults: ToolResult[] = [];

  for (const msg of messages) {
    const { text, images, toolResults } = processMessageContent(
      msg.content,
      rejectUnsupportedDocuments,
    );
    if (text) contentParts.push(text);
    allImages.push(...images);
    allToolResults.push(...toolResults);
  }

  const content = contentParts.join('\n');
  const userMsg = createUserMessage(content, modelId);

  if (allImages.length > 0) {
    userMsg.images = allImages;
  }

  if (allToolResults.length > 0) {
    userMsg.userInputMessageContext = {
      ...userMsg.userInputMessageContext,
      toolResults: allToolResults,
    };
  }

  return {
    kind: 'user',
    userInputMessage: userMsg,
  };
}

// ============================================================================
// Build history
// ============================================================================

/**
 * Build history messages.
 *
 * @param req - Original request (for system, thinking, etc.)
 * @param messages - Pre-processed message slice (trailing assistant prefill removed)
 * @param modelId - Mapped Kiro model ID
 * @param toolNameMap - Mutable tool name mapping
 */
function pushSystemDirectivePair(
  history: KiroMessage[],
  userContent: string,
  modelId: string,
): void {
  history.push({
    kind: 'user',
    userInputMessage: createUserMessage(userContent, modelId),
  });
  history.push({
    kind: 'assistant',
    assistantResponseMessage: createAssistantMessage('I will follow these instructions.'),
  });
}

function buildHistory(
  req: MessagesRequest,
  messages: ClaudeMessage[],
  modelId: string,
  toolNameMap: Map<string, string>,
  identityOverride: boolean,
  rejectUnsupportedDocuments: boolean,
): KiroMessage[] {
  const history: KiroMessage[] = [];

  // 走原生 reasoning 路径的 model（4.7/4.8）：thinking 在 wire 字段
  // `userInputMessage.reasoning.effort` 上传递，**不**再注入 `<thinking_mode>`
  // prompt 前缀，避免 prompt 和 wire 字段双重处理。
  // 其它 model 走 prompt 注入路径作为 fallback。
  const thinkingPrefix = usesNativeReasoning(modelId) ? undefined : generateThinkingPrefix(req);

  // 1. Process system messages
  // 判断基于"拼接后的 systemContent"而非 req.system 数组长度:客户端可能发
  // `system: [{text: ''}]`——数组非空但内容为空。这种情况必须等价于"无 system",
  // 照常注入 thinking/identity,否则会连身份覆写一起丢掉(模型裸奔暴露上游身份)。
  const systemContent = req.system?.map((s) => s.text).join('\n') ?? '';

  if (systemContent) {
    const content = identityOverride
      ? `${systemContent}\n\n${IDENTITY_OVERRIDE_DIRECTIVE}`
      : systemContent;

    // Inject thinking tags at the start if needed and not already present
    const finalContent =
      thinkingPrefix && !hasThinkingTags(content) ? `${thinkingPrefix}\n${content}` : content;

    pushSystemDirectivePair(history, finalContent, modelId);
  } else if (thinkingPrefix || identityOverride) {
    // 无客户端 system 文本,内容仅由 server 拼装(thinkingPrefix + 身份指令),
    // 不会出现"客户端自带 <thinking_mode>"的重复,故不需要上面分支的 hasThinkingTags 去重。
    const parts: string[] = [];
    if (thinkingPrefix) parts.push(thinkingPrefix);
    if (identityOverride) parts.push(IDENTITY_OVERRIDE_DIRECTIVE);
    pushSystemDirectivePair(history, parts.join('\n\n'), modelId);
  }

  // 2. Process regular message history
  // Last message becomes currentMessage, not added to history
  const historyEndIndex = messages.length - 1;

  let userBuffer: ClaudeMessage[] = [];
  let assistantBuffer: ClaudeMessage[] = [];

  for (let i = 0; i < historyEndIndex; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      // Flush accumulated assistant messages
      if (assistantBuffer.length > 0) {
        history.push(mergeAssistantMessages(assistantBuffer, toolNameMap));
        assistantBuffer = [];
      }
      userBuffer.push(msg);
    } else if (msg.role === 'assistant') {
      // Flush accumulated user messages
      if (userBuffer.length > 0) {
        history.push(mergeUserMessages(userBuffer, modelId, rejectUnsupportedDocuments));
        userBuffer = [];
      }
      assistantBuffer.push(msg);
    }
  }

  // Flush trailing assistant messages
  if (assistantBuffer.length > 0) {
    history.push(mergeAssistantMessages(assistantBuffer, toolNameMap));
  }

  // Handle trailing orphan user messages
  if (userBuffer.length > 0) {
    history.push(mergeUserMessages(userBuffer, modelId, rejectUnsupportedDocuments));

    // Auto-pair with an "OK" assistant response
    const autoAssistant = createAssistantMessage('OK');
    history.push({ kind: 'assistant', assistantResponseMessage: autoAssistant });
  }

  getLogger().debug({
    msg: 'history built',
    history_entry_count: history.length,
    source_message_count: messages.length - 1,
    has_system_prompt: !!(req.system && req.system.length > 0),
    thinking_type: req.thinking?.type,
    budget_tokens: req.thinking?.budget_tokens,
  });

  return history;
}

// ============================================================================
// System-role message folding (Claude Code <system-reminder> blocks)
// ============================================================================

/** Extract plain text from a `system`-role message's content (string or text blocks). */
function systemMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const block = item as ContentBlock;
        if (block.type === 'text' && block.text) parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Return a copy of `msg` with `extra` folded into its content. String content is
 * concatenated; block-array content gets a `text` block unshifted (`prepend`) or
 * pushed (`append`) — so a tool_result-only user message keeps its tool_result
 * blocks intact while also carrying the reminder text.
 */
function foldTextIntoMessage(
  msg: ClaudeMessage,
  extra: string,
  where: 'prepend' | 'append',
): ClaudeMessage {
  if (!extra) return msg;
  const c = msg.content;
  if (typeof c === 'string') {
    return { ...msg, content: where === 'prepend' ? `${extra}\n${c}` : `${c}\n${extra}` };
  }
  const arr: unknown[] = Array.isArray(c) ? [...c] : [];
  const block: ContentBlock = { type: 'text', text: extra };
  if (where === 'prepend') arr.unshift(block);
  else arr.push(block);
  return { ...msg, content: arr };
}

/**
 * Fold `role: "system"` messages that Claude Code (and similar clients)
 * interleave into `messages[]` — the `<system-reminder>` blocks: plan-mode
 * directives ("you are in plan mode, call ExitPlanMode"), tool-usage nudges,
 * agent-capability lists, security notices, etc.
 *
 * Kiro's conversation history has only `user`/`assistant` roles and
 * `buildHistory` iterates on exactly those two, so a `system` entry hits no
 * branch and is silently dropped; a *trailing* one is additionally mistaken for
 * an assistant "prefill" and discarded. Either way the reminder never reaches
 * the model — which is what breaks plan mode (the ExitPlanMode directive is one
 * such reminder) and degrades tool behavior.
 *
 * These reminders are logically part of the surrounding *user* turn, so fold
 * each one's text into the adjacent user message: appended to the immediately
 * preceding user message when there is one, else buffered and prepended onto the
 * next user message. A leading/orphan run with no user to attach to becomes its
 * own user message so the content still reaches the model. No new role is
 * introduced, so strict user/assistant alternation is preserved.
 */
function foldSystemMessages(messages: ClaudeMessage[]): ClaudeMessage[] {
  if (!messages.some((m) => m.role === 'system')) return messages;

  const out: ClaudeMessage[] = [];
  let pending: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = systemMessageText(msg.content);
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        out[out.length - 1] = foldTextIntoMessage(prev, text, 'append');
      } else {
        pending.push(text);
      }
      continue;
    }
    if (msg.role === 'user' && pending.length > 0) {
      out.push(foldTextIntoMessage(msg, pending.join('\n'), 'prepend'));
      pending = [];
    } else {
      out.push(msg);
    }
  }

  // Trailing/orphan system text (no following user): attach to the last user
  // message if any, else materialize a user message so it still reaches Kiro.
  if (pending.length > 0) {
    const text = pending.join('\n');
    const lastUserIdx = findLastIndex(out, (m) => m.role === 'user');
    if (lastUserIdx >= 0) {
      out[lastUserIdx] = foldTextIntoMessage(out[lastUserIdx], text, 'append');
    } else {
      out.push({ role: 'user', content: text });
    }
  }

  return out;
}

// ============================================================================
// Leaked tool-call text decontamination (assistant history)
// ============================================================================

/**
 * 请求级去污染总预算（毫秒）。检测器自身有实例级熔断，但 strip 对每条
 * assistant 消息各建一个实例——病态历史 × 每请求全量重扫仍可能累计成秒级
 * 同步阻塞。超预算后剩余消息原样透传（不丢内容），保证单个会话的毒历史
 * 烧不穿事件循环拖累其它会话。
 */
const STRIP_BUDGET_MS = 250;

/**
 * 剥掉 assistant 历史文本里泄漏的工具调用标记块（tool-call-text.ts）。
 *
 * 泄漏块从未真正执行（下游只见到文本），留在历史里会被模型当作正确示范
 * 模仿，导致同一会话确定性复发。只剥**格式完整**的块——结构悬空的前缀
 * 原样保留（永不丢弃，见 tool-call-text.ts 文件头）。只处理 assistant
 * 消息的 text 内容；结构化 tool_use 块与 user 消息永不触碰。同一消息的
 * 多个 text 块共享一个 ToolCallTextStripper（围栏可能跨块开合，独立检测
 * 会误剥第二块里围栏内的示例）。整条消息被剥空时用单空格占位（Kiro 要求
 * content 非空）。
 */
function stripLeakedToolCallsFromAssistantHistory(
  messages: ClaudeMessage[],
  registry: ToolTextRegistry,
): ClaudeMessage[] {
  const stripStart = Date.now();
  let strippedCount = 0;
  let budgetExhausted = false;

  const out = messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;
    if (budgetExhausted) return msg;
    if (Date.now() - stripStart > STRIP_BUDGET_MS) {
      budgetExhausted = true;
      getLogger().warn({
        msg: 'assistant history decontamination budget exceeded, passing rest through',
        strip_elapsed_ms: Date.now() - stripStart,
      });
      return msg;
    }

    const stripper = new ToolCallTextStripper(registry);
    const stripText = (text: string): string => {
      const stripped = stripper.stripBlock(text);
      if (stripped !== text) strippedCount++;
      return stripped;
    };

    if (typeof msg.content === 'string') {
      const stripped = stripText(msg.content);
      if (stripped === msg.content) return msg;
      return { ...msg, content: stripped.trim() ? stripped : ' ' };
    }

    if (Array.isArray(msg.content)) {
      let changed = false;
      const blocks = msg.content.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const block = item as ContentBlock;
        if (block.type !== 'text' || typeof block.text !== 'string') return item;
        const stripped = stripText(block.text);
        if (stripped === block.text) return item;
        changed = true;
        return { ...block, text: stripped };
      });
      if (!changed) return msg;
      // 整条消息被剥空（Claude Code 的 assistant 历史都是块数组，纯泄漏 turn
      // 就是单个 text 块）时同样需要占位——与 string 分支的 ' ' 兜底对齐，
      // 避免空 content 上送违反 Kiro 非空约束。
      const stillHasContent = blocks.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const block = item as ContentBlock;
        if (block.type === 'text') return typeof block.text === 'string' && !!block.text.trim();
        return true;
      });
      return { ...msg, content: stillHasContent ? blocks : ' ' };
    }

    return msg;
  });

  if (strippedCount > 0) {
    getLogger().warn({
      msg: 'stripped leaked tool-call text from assistant history',
      stripped_blocks: strippedCount,
    });
  }
  return out;
}

// ============================================================================
// Main conversion function
// ============================================================================

/**
 * 把 Claude Messages 请求转换为 Kiro `ConversationState`。
 *
 * body 形态完全对齐 kiro-cli 2.0+ 抓包：`origin=KIRO_CLI`、
 * `agentTaskType=vibe`、`chatTriggerType=MANUAL`、`envState.operatingSystem`
 * 按 runtime 平台渲染、`envState.currentWorkingDirectory=process.cwd()`。
 * 请求级的语义字段（origin / envState）都从 `getKiroClientProfile()` 取，
 * 和 provider / token-manager 使用同一个 profile 源，保证三端一致。
 */
export function convertRequest(
  req: MessagesRequest,
  options: ConvertRequestOptions = {},
): ConversionResult {
  const identityOverride = options.identityOverride ?? true;
  const rejectUnsupportedDocuments = options.rejectUnsupportedDocuments ?? false;
  // `??` only substitutes on nullish, so an explicit 0 / negative / non-integer
  // from a direct library caller (the env path is schema-guarded to 1..1_000_000)
  // would reach convertTools and corrupt every description (0 → all truncated to
  // '', -n → last n code points dropped). Fall back to the default for any value
  // that isn't a positive integer.
  const rawMaxLen = options.toolDescriptionMaxLen;
  const toolDescriptionMaxLen =
    rawMaxLen !== undefined && Number.isInteger(rawMaxLen) && rawMaxLen > 0
      ? rawMaxLen
      : DEFAULT_TOOL_DESCRIPTION_MAX_LEN;

  // 1. Map model
  const modelId = mapModel(req.model);
  if (!modelId) {
    throw new ConversionError('UnsupportedModel', `Model not supported: ${req.model}`);
  }

  // 2. Check messages list
  if (!req.messages || req.messages.length === 0) {
    throw new ConversionError('EmptyMessages', 'Messages list is empty');
  }

  // 2.2. Fold interleaved `system`-role messages (Claude Code <system-reminder>
  // blocks) into adjacent user turns so they reach the model, instead of being
  // dropped by buildHistory (which only iterates user/assistant). Runs BEFORE the
  // prefill discard so a trailing system reminder is folded into the last user
  // turn rather than mistaken for an assistant prefill.
  let foldedMessages = foldSystemMessages(req.messages);
  if (foldedMessages.length === 0) {
    throw new ConversionError('EmptyMessages', 'No user message found in messages list');
  }

  // 2.3. 历史去污染：剥掉 assistant 历史文本里泄漏的工具调用标记块，阻断
  // 模型模仿坏格式的自我污染循环（详见 stripLeakedToolCallsFromAssistantHistory）。
  if (options.toolTextRegistry) {
    foldedMessages = stripLeakedToolCallsFromAssistantHistory(
      foldedMessages,
      options.toolTextRegistry,
    );
  }

  // 2.5. Preprocess prefill: a genuine trailing assistant message (client-side
  // prefill) has no Kiro currentMessage equivalent, so discard it.
  let messages: ClaudeMessage[];
  if (foldedMessages[foldedMessages.length - 1].role !== 'user') {
    getLogger().info('Detected trailing assistant message (prefill), silently discarding');
    const lastUserIdx = findLastIndex(foldedMessages, (m) => m.role === 'user');
    if (lastUserIdx < 0) {
      throw new ConversionError('EmptyMessages', 'No user message found in messages list');
    }
    messages = foldedMessages.slice(0, lastUserIdx + 1);
  } else {
    messages = foldedMessages;
  }

  // 3. Generate conversation ID and agent continuation ID
  // typeof 守卫:metadata 是宽松类型,客户端可能传非字符串 user_id;直接传给
  // extractSessionId(内部走 String.indexOf)会抛 TypeError —— 非 ConversionError,
  // 会冒泡成未捕获 500。非字符串一律回退到随机 conversationId。
  const conversationId =
    typeof req.metadata?.user_id === 'string'
      ? (extractSessionId(req.metadata.user_id) ?? uuidv4())
      : uuidv4();
  const agentContinuationId = uuidv4();

  // 4. 从 client profile 拿本次请求所有 body 字段的真值
  const profile = getKiroClientProfile();
  const chatTriggerType = profile.body.chatTriggerType;
  const agentTaskType = profile.body.agentTaskType;
  const bodyOrigin = profile.body.origin;
  // envState 在整次请求里是常量；算一次复用给 current + history 所有 user message
  const envState = {
    operatingSystem: renderOperatingSystem(profile),
    currentWorkingDirectory: process.cwd(),
  };

  // 5. Process last message as current_message
  const lastMessage = messages[messages.length - 1];
  const {
    text: textContent,
    images,
    toolResults,
  } = processMessageContent(lastMessage.content, rejectUnsupportedDocuments);

  // 6. Convert tool definitions
  const toolNameMap = new Map<string, string>();
  const tools = convertTools(req.tools, toolNameMap, toolDescriptionMaxLen);

  // 7. Build history (need to build first to collect history tool names)
  const history = buildHistory(
    req,
    messages,
    modelId,
    toolNameMap,
    identityOverride,
    rejectUnsupportedDocuments,
  );

  // 7.5. kiro-cli 抓包显示 history 里每条 user message 都带 origin + envState。
  // 工厂默认值已经把 origin 填成 KIRO_CLI，但 envState 依赖 runtime 状态
  // （currentWorkingDirectory = process.cwd()），所以在 converter 层统一回填。
  for (const entry of history) {
    if (entry.kind !== 'user') continue;
    entry.userInputMessage.origin = bodyOrigin;
    entry.userInputMessage.userInputMessageContext = {
      ...entry.userInputMessage.userInputMessageContext,
      envState,
    };
  }

  // 8. Validate and filter tool_use/tool_result pairing
  const [validatedToolResults, orphanedToolUseIds] = validateToolPairing(history, toolResults);

  // 9. Remove orphaned tool_uses from history
  removeOrphanedToolUses(history, orphanedToolUseIds);

  // 10. Collect history tool names and create placeholder definitions for missing tools
  const historyToolNames = collectHistoryToolNames(history);
  const existingToolNamesLower = new Set(tools.map((t) => t.toolSpecification.name.toLowerCase()));
  const toolCountBeforePlaceholders = tools.length;

  for (const toolName of historyToolNames) {
    // A tool-search marker referenced in history must NOT be resurrected as a
    // placeholder: createPlaceholderTool emits an empty-`properties` schema —
    // exactly the degenerate tool convertTools drops to avoid Kiro's HTTP 400.
    if (toolName.startsWith(TOOL_SEARCH_TOOL_NAME_PREFIX)) continue;
    if (!existingToolNamesLower.has(toolName.toLowerCase())) {
      tools.push(createPlaceholderTool(toolName));
    }
  }

  const placeholderCount = tools.length - toolCountBeforePlaceholders;
  if (placeholderCount > 0) {
    getLogger().debug({
      msg: 'placeholder tools created for history-referenced tools',
      placeholder_count: placeholderCount,
    });
  }

  // 11. Build UserInputMessageContext —— current message 同样带 envState
  const context: UserInputMessageContext = {
    toolResults: validatedToolResults,
    tools,
    envState,
  };

  // 12. Build current message
  // 身份 directive 只注入 system 层(buildHistory 落在 history 第一轮),不再追加到
  // 当前用户消息末尾——current message 保持客户端原文,避免污染纯 tool_result。
  const userInput: UserInputMessage = {
    ...createUserInputMessage(textContent, modelId),
    userInputMessageContext: context,
    images,
    origin: bodyOrigin,
  };

  // 12b. 原生 reasoning 注入：仅对 4.7/4.8 等支持的 model 生效。
  // 双通道映射在 mapThinkingToEffort 里。其它 model 走 buildHistory 里的
  // prompt 注入路径，保持现有 fallback。
  if (usesNativeReasoning(modelId)) {
    const effort = mapThinkingToEffort(req.thinking, req.output_config);
    if (effort) {
      userInput.reasoning = { effort };
      getLogger().debug({
        msg: 'native reasoning effort injected',
        model: modelId,
        thinking_type: req.thinking?.type,
        effort,
      });
    }
  }

  const currentMessage: CurrentMessage = {
    userInputMessage: userInput,
  };

  // 13. Build ConversationState
  const conversationState: ConversationState = {
    conversationId,
    agentContinuationId,
    agentTaskType,
    chatTriggerType,
    currentMessage,
    history,
  };

  if (toolNameMap.size > 0) {
    getLogger().info(`Tool name mapping: ${toolNameMap.size} long name(s) shortened`);
  }

  getLogger().debug({
    msg: 'conversion details',
    input_model: req.model,
    mapped_model: modelId,
    tool_count: tools.length,
    history_message_count: history.length,
    system_prompt_length: req.system?.reduce((n, s) => n + s.text.length, 0) ?? 0,
    tool_name_mappings: toolNameMap.size,
  });

  return {
    conversationState,
    toolNameMap,
  };
}

/** Array findLastIndex polyfill */
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}
