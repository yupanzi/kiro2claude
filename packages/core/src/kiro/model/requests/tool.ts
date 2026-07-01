/** 工具定义 */
export interface Tool {
  toolSpecification: ToolSpecification;
}

/** 工具规范 */
export interface ToolSpecification {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

/** 输入模式 (JSON Schema 包装) */
export interface InputSchema {
  json: Record<string, unknown>;
}

export function defaultInputSchema(): InputSchema {
  return {
    json: { type: 'object', properties: {} },
  };
}

/** 工具执行结果 */
export interface ToolResult {
  toolUseId: string;
  content: Record<string, unknown>[];
  status?: string;
  isError?: boolean;
}

export function toolResultSuccess(toolUseId: string, content: string): ToolResult {
  return {
    toolUseId,
    content: [{ text: content }],
    status: 'success',
    isError: false,
  };
}

export function toolResultError(toolUseId: string, errorMessage: string): ToolResult {
  return {
    toolUseId,
    content: [{ text: errorMessage }],
    status: 'error',
    isError: true,
  };
}

/** 工具使用条目（历史消息中记录工具调用） */
export interface ToolUseEntry {
  toolUseId: string;
  name: string;
  input: unknown;
}

export function createToolUseEntry(
  toolUseId: string,
  name: string,
  input: unknown = {},
): ToolUseEntry {
  return { toolUseId, name, input };
}
