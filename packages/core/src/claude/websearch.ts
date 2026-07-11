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
import { createSseEvent, type SseEvent, safeEnd, safeWrite, sseEventToString } from './stream.js';
import { createErrorResponse, type MessagesRequest } from './types.js';

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
 * Condition: tools has exactly one item, and its name is "web_search"
 */
export function hasWebSearchTool(req: MessagesRequest): boolean {
  return !!req.tools && req.tools.length === 1 && req.tools[0].name === 'web_search';
}

/**
 * Extract search query from messages.
 *
 * Reads the first message's first content block and strips
 * "Perform a web search for the query: " prefix.
 */
export function extractSearchQuery(req: MessagesRequest): string | undefined {
  const firstMsg = req.messages?.[0];
  if (!firstMsg) return undefined;

  let text: string | undefined;

  if (typeof firstMsg.content === 'string') {
    text = firstMsg.content;
  } else if (Array.isArray(firstMsg.content)) {
    const firstBlock = firstMsg.content[0] as Record<string, unknown> | undefined;
    if (firstBlock?.type === 'text' && typeof firstBlock.text === 'string') {
      text = firstBlock.text;
    }
  }

  if (!text) return undefined;

  const PREFIX = 'Perform a web search for the query: ';
  const query = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;

  return query || undefined;
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
  if (!result || !Array.isArray(result.content)) return undefined;

  const content = result.content[0];
  if (!content || content.type !== 'text') return undefined;

  try {
    const parsed = JSON.parse(content.text) as WebSearchResults;
    // 上游 JSON 不保证含 results 数组(可能是 {totalResults:0} / {error:...} 等);
    // 未通过校验则按"无结果"返回 undefined。否则下游 generateWebsearchEvents /
    // generateSearchSummary 对 searchResults.results 调 .map/.forEach 会抛 TypeError,
    // 而该处在 try/catch 之外 → 冒泡成 500,而非优雅的空结果 SSE。
    if (!parsed || !Array.isArray(parsed.results)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

// ============================================================================
// SSE event generation
// ============================================================================

/**
 * Generate WebSearch SSE event sequence
 */
function generateWebsearchEvents(
  model: string,
  query: string,
  toolUseId: string,
  searchResults: WebSearchResults | undefined,
  inputTokens: number,
): SseEvent[] {
  const events: SseEvent[] = [];
  const messageId = `msg_${uuidv4().replace(/-/g, '').slice(0, 24)}`;

  // 1. message_start
  events.push(
    createSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  );

  // 2. content_block_start (text - search decision, index 0)
  const decisionText = `I'll search for "${query}".`;
  events.push(
    createSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
  );

  events.push(
    createSseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: decisionText },
    }),
  );

  events.push(
    createSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
  );

  // 3. content_block_start (server_tool_use, index 1)
  events.push(
    createSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: {
        id: toolUseId,
        type: 'server_tool_use',
        name: 'web_search',
        input: { query },
      },
    }),
  );

  // 4. content_block_stop (server_tool_use)
  events.push(
    createSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 1,
    }),
  );

  // 5. content_block_start (web_search_tool_result, index 2)
  const searchContent = searchResults
    ? searchResults.results.map((r) => {
        const pageAge = r.publishedDate ? formatPageAgeUTC(r.publishedDate) : null;
        return {
          type: 'web_search_result',
          title: r.title,
          url: r.url,
          encrypted_content: r.snippet ?? '',
          page_age: pageAge,
        };
      })
    : [];

  events.push(
    createSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 2,
      content_block: {
        type: 'web_search_tool_result',
        content: searchContent,
      },
    }),
  );

  // 6. content_block_stop (web_search_tool_result)
  events.push(
    createSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 2,
    }),
  );

  // 7. content_block_start (text, index 3)
  events.push(
    createSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'text', text: '' },
    }),
  );

  // 8. content_block_delta (text_delta) - search result summary
  const summary = generateSearchSummary(query, searchResults);

  // Chunked text sending
  const chunkSize = 100;
  const chars = [...summary];
  for (let i = 0; i < chars.length; i += chunkSize) {
    const chunk = chars.slice(i, i + chunkSize).join('');
    events.push(
      createSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 3,
        delta: { type: 'text_delta', text: chunk },
      }),
    );
  }

  // 9. content_block_stop (text)
  events.push(
    createSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 3,
    }),
  );

  // 10. message_delta
  const outputTokens = Math.floor((summary.length + 3) / 4);
  events.push(
    createSseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        output_tokens: outputTokens,
        server_tool_use: { web_search_requests: 1 },
      },
    }),
  );

  // 11. message_stop
  events.push(createSseEvent('message_stop', { type: 'message_stop' }));

  return events;
}

/** Generate search result summary */
function generateSearchSummary(query: string, results: WebSearchResults | undefined): string {
  let summary = `Here are the search results for "${query}":\n\n`;

  if (results) {
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
 * Writes SSE response to the reply.
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
    if (searchResults) {
      log.debug({
        msg: 'WebSearch results parsed',
        total_results: searchResults.totalResults,
        result_titles: searchResults.results.slice(0, 5).map((r) => r.title.slice(0, 80)),
      });
    }
    log.info({
      msg: 'WebSearch MCP call succeeded',
      result_count: searchResults?.results.length ?? 0,
      duration_ms: Date.now() - mcpStart,
    });
  } catch (e) {
    log.warn({
      msg: 'WebSearch MCP call failed',
      duration_ms: Date.now() - mcpStart,
      error: String(e),
    });
    searchResults = undefined;
  }

  // 4. Generate and send SSE response
  const events = generateWebsearchEvents(
    payload.model,
    query,
    toolUseId,
    searchResults,
    inputTokens,
  );

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
