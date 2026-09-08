/**
 * WebSearch tool handling module
 *
 * Implements Claude WebSearch request to Kiro MCP conversion and response generation.
 */

import type { FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { KiroProvider } from '../kiro/provider.js';
import { getLogger } from '../shared/logger.js';
import { getRequestContext } from '../shared/request-context.js';
import { mapProviderError } from './error-mapper.js';
import { createSseEvent, type SseEvent, safeEnd, safeWrite, sseEventToString } from './stream.js';
import { type ContentBlock, createErrorResponse, type MessagesRequest } from './types.js';

// ============================================================================
// MCP types
// ============================================================================

interface McpRequest {
  id: string;
  jsonrpc: string;
  method: string;
  params: {
    name: string;
    arguments: {
      query: string;
    };
  };
}

interface McpResponse {
  error?: {
    code?: number;
    message?: string;
  };
  id: string;
  jsonrpc: string;
  result?: {
    content: Array<{
      type: string;
      text: string;
    }>;
    isError: boolean;
  };
}

// ============================================================================
// WebSearch result types
// ============================================================================

interface WebSearchResults {
  results: WebSearchResult[];
  totalResults?: number;
  query?: string;
  error?: string;
}

interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: number;
  id?: string;
  domain?: string;
  maxVerbatimWordLimit?: number;
  publicDomain?: boolean;
}

// ============================================================================
// Date formatting (UTC only — see static guard in
// test/static/no-local-date-apis.test.ts)
// ============================================================================

/**
 * Format a web search result's published date as `"Month D, YYYY"` in UTC.
 *
 * ## Why this is the only sanctioned `toLocaleDateString` call in the codebase
 *
 * JavaScript's `toLocaleDateString` defaults to the **host's local timezone**,
 * so the same millisecond timestamp renders differently on servers in
 * different regions — a midnight-UTC date shows up as the previous day in
 * any negative-UTC timezone. This would be a silent, cross-region wire-format
 * divergence and a bug magnet: the same web search result would be stamped
 * with different dates depending on which server handled the request.
 *
 * This helper centralizes the UTC rendering so that:
 *
 * 1. All `pageAge` strings are region-independent — byte-for-byte identical
 *    regardless of host timezone.
 * 2. The rest of the codebase can be mechanically forbidden from calling any
 *    local-time `Date` API (see the static test in
 *    `test/static/no-local-date-apis.test.ts`). This file is the **only**
 *    file allowed to call `toLocaleDateString`.
 *
 * Returns `null` if the input is not a valid timestamp.
 */
export function formatPageAgeUTC(publishedDate: number): string | null {
  if (!Number.isFinite(publishedDate)) return null;
  const date = new Date(publishedDate);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return null;
  }
}

// ============================================================================
// Detection and extraction
// ============================================================================

/**
 * Check if request is a pure WebSearch request.
 *
 * Only an explicitly hosted WebSearch tool can bypass model inference.
 * A client-defined function with the same name must remain a client tool.
 */
export function hasWebSearchTool(req: MessagesRequest): boolean {
  const tool = req.tools?.length === 1 ? req.tools[0] : undefined;
  return tool?.name === 'web_search' && /^web_search_\d{8}$/.test(tool.type ?? '');
}

/** Extract the latest user query; preceding turns must not change the search target. */
export function extractSearchQuery(req: MessagesRequest): string | undefined {
  const message = req.messages.findLast((item) => item.role === 'user');
  if (!message) return undefined;
  const text =
    typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : '';
  const prefix = 'Perform a web search for the query: ';
  return (text.startsWith(prefix) ? text.slice(prefix.length) : text).trim() || undefined;
}

// ============================================================================
// Random ID generation
// ============================================================================

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LOWER_ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateRandomId(length: number, charset: string): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[Math.floor(Math.random() * charset.length)];
  }
  return result;
}

// ============================================================================
// MCP request creation
// ============================================================================

/**
 * Create MCP request.
 *
 * ID format: web_search_tooluse_{22-char random}_{ms timestamp}_{8-char random}
 *
 * @returns [tool_use_id, McpRequest]
 */
function createMcpRequest(query: string): [string, McpRequest] {
  const random22 = generateRandomId(22, ALPHANUM);
  const timestamp = Date.now();
  const random8 = generateRandomId(8, LOWER_ALPHANUM);

  const requestId = `web_search_tooluse_${random22}_${timestamp}_${random8}`;

  const toolUseId = `srvtoolu_${uuidv4().replace(/-/g, '').slice(0, 32)}`;

  const request: McpRequest = {
    id: requestId,
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: { query },
    },
  };

  return [toolUseId, request];
}

// ============================================================================
// MCP response parsing
// ============================================================================

function parseSearchResults(mcpResponse: McpResponse): WebSearchResults | undefined {
  const result = mcpResponse.result;
  if (!result || result.isError || !Array.isArray(result.content)) return undefined;

  const content = result.content[0];
  if (!content || content.type !== 'text') return undefined;

  try {
    const parsed = JSON.parse(content.text) as WebSearchResults;
    // Invalid provider payloads are errors, not an empty successful search.
    // An explicit results: [] is the only successful "no results" representation.
    if (!parsed || parsed.error || !Array.isArray(parsed.results)) return undefined;
    if (
      parsed.results.some(
        (item) =>
          !item ||
          typeof item.title !== 'string' ||
          typeof item.url !== 'string' ||
          (item.snippet != null && typeof item.snippet !== 'string') ||
          (item.publishedDate != null && !Number.isFinite(item.publishedDate)),
      )
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// ============================================================================
// SSE event generation
// ============================================================================

interface WebsearchMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn';
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    server_tool_use: { web_search_requests: number };
  };
}

/** One result representation shared by JSON and SSE clients. */
function buildWebsearchMessage(
  model: string,
  query: string,
  toolUseId: string,
  results: WebSearchResults,
  inputTokens: number,
): WebsearchMessage {
  const summary = generateSearchSummary(query, results);
  const decision = `I'll search for "${query}".`;
  return {
    id: `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'text', text: decision },
      { type: 'server_tool_use', id: toolUseId, name: 'web_search', input: { query } },
      {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        content: results.results.map((result) => ({
          type: 'web_search_result',
          title: result.title,
          url: result.url,
          encrypted_content: result.snippet ?? '',
          page_age: result.publishedDate ? formatPageAgeUTC(result.publishedDate) : null,
        })),
      },
      { type: 'text', text: summary },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: Math.ceil((decision.length + summary.length) / 4),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 1 },
    },
  };
}

function generateWebsearchEvents(message: WebsearchMessage): SseEvent[] {
  const events = [
    createSseEvent('message_start', {
      type: 'message_start',
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    }),
  ];
  for (const [index, block] of message.content.entries()) {
    events.push(
      createSseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: block.type === 'text' ? { type: 'text', text: '' } : block,
      }),
    );
    if (block.type === 'text') {
      const chars = [...(block.text ?? '')];
      for (let offset = 0; offset < chars.length; offset += 100) {
        events.push(
          createSseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: chars.slice(offset, offset + 100).join('') },
          }),
        );
      }
    }
    events.push(createSseEvent('content_block_stop', { type: 'content_block_stop', index }));
  }
  events.push(
    createSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: {
        output_tokens: message.usage.output_tokens,
        server_tool_use: message.usage.server_tool_use,
      },
    }),
  );
  events.push(createSseEvent('message_stop', { type: 'message_stop' }));
  return events;
}

/** Generate search result summary */
function generateSearchSummary(query: string, results: WebSearchResults | undefined): string {
  let summary = `Here are the search results for "${query}":\n\n`;

  if (results && results.results.length > 0) {
    results.results.forEach((result, i) => {
      summary += `${i + 1}. **${result.title}**\n`;
      if (result.snippet) {
        // Truncate long snippets (safe UTF-8)
        const chars = [...result.snippet];
        const truncated =
          chars.length > 200 ? `${chars.slice(0, 200).join('')}...` : result.snippet;
        summary += `   ${truncated}\n`;
      }
      summary += `   Source: ${result.url}\n\n`;
    });
  } else {
    summary += 'No results found.\n';
  }

  summary +=
    '\nPlease note that these are web search results and may not be fully accurate or up-to-date.';

  return summary;
}

// ============================================================================
// MCP API call
// ============================================================================

async function callMcpApi(provider: KiroProvider, request: McpRequest): Promise<McpResponse> {
  const requestBody = JSON.stringify(request);

  const response = await provider.callMcp(requestBody);
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

  const mcpResponse: McpResponse = JSON.parse(body);

  if (mcpResponse.error) {
    throw new Error(
      `MCP error: ${mcpResponse.error.code ?? -1} - ${mcpResponse.error.message ?? 'Unknown error'}`,
    );
  }

  return mcpResponse;
}

// ============================================================================
// Main handler
// ============================================================================

/**
 * Handle WebSearch request.
 *
 * Honors the requested JSON/SSE transport and preserves search failure semantics.
 */
export async function handleWebsearchRequest(
  provider: KiroProvider,
  payload: MessagesRequest,
  inputTokens: number,
  reply: FastifyReply,
): Promise<void> {
  // 1. Extract search query
  const query = extractSearchQuery(payload);
  if (!query) {
    reply
      .status(400)
      .send(
        createErrorResponse('invalid_request_error', 'Cannot extract search query from messages'),
      );
    return;
  }

  const log = getLogger();
  log.info({ msg: 'processing WebSearch request', query });

  // 2. Create MCP request
  const [toolUseId, mcpRequest] = createMcpRequest(query);
  log.debug({
    msg: 'WebSearch MCP request created',
    request_id: mcpRequest.id,
    tool_use_id: toolUseId,
  });

  // 3. Call Kiro MCP API
  let searchResults: WebSearchResults | undefined;
  const mcpStart = Date.now();
  try {
    const mcpResponse = await callMcpApi(provider, mcpRequest);
    searchResults = parseSearchResults(mcpResponse);
    // 解析不出结构化结果 = 搜索失败,不是「零结果的成功搜索」(只有显式 `results: []`
    // 才是后者)。抛出去和 MCP 调用本身失败走同一条错误出口。
    if (!searchResults) throw new Error('Invalid web search response');
    log.debug({
      msg: 'WebSearch results parsed',
      total_results: searchResults.totalResults,
      result_titles: searchResults.results.slice(0, 5).map((r) => r.title.slice(0, 80)),
    });
    log.info({
      msg: 'WebSearch MCP call succeeded',
      result_count: searchResults.results.length,
      duration_ms: Date.now() - mcpStart,
    });
  } catch (e) {
    log.warn({
      msg: 'WebSearch MCP call failed',
      duration_ms: Date.now() - mcpStart,
      error: String(e),
    });
    mapProviderError(e, reply);
    return;
  }

  // 4. Render the same result through the requested transport.
  const message = buildWebsearchMessage(
    payload.model,
    query,
    toolUseId,
    searchResults,
    inputTokens,
  );

  if (!payload.stream) {
    reply.send(message);
    return;
  }
  const events = generateWebsearchEvents(message);

  // Inject x-request-id for streaming responses
  const sseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  };
  const reqCtx = getRequestContext();
  if (reqCtx) {
    sseHeaders['x-request-id'] = reqCtx.reqId;
  }
  reply.raw.writeHead(200, sseHeaders);

  for (const event of events) {
    if (!safeWrite(reply.raw, sseEventToString(event))) {
      // Client disconnected mid-response; no point continuing the fan-out
      break;
    }
  }

  safeEnd(reply.raw);
}
