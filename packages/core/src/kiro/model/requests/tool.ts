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

/**
 * 工具执行结果。
 *
 * kiro-cli 2.21.1 实测形态（探针 `test/manual/kiro-cli-probe.ts` 驱动真实工具）：
 * ```
 * 成功: { toolUseId, content:[{ text }] | [{ json:{…} }], status:"success" }
 * 失败: { toolUseId, content:[{ text }],                   status:"error"   }
 * ```
 * 两点与本项目的差异，都**已知且刻意保持现状**：
 *
 * 1. **`isError` kiro-cli 根本不发**（只用 `status` 区分），我们两个都发，上游实测
 *    照收。不删的理由：无法从外部区分「上游忽略未知字段」与「上游读的就是
 *    isError」，删错则错误结果被当成成功喂给模型。要动先做对照实验（content 保持
 *    中性、只改 status/isError，看模型是否仍判为失败）。
 * 2. **`content[]` 上游支持 `{json}` 通道**（`execute_bash` 回
 *    `{json:{stdout,stderr,exit_status}}`），我们只产 `{text}`。可接受的降级：下游
 *    送来的 tool_result 本就是文本/blocks，结构化信息在进网关前已序列化过一次。
 *
 * ⚠ `status` 表示**工具本身是否执行成功**，不是业务结果：`exit 42` 仍是 `"success"`
 * （拿到了退出码），只有参数校验失败这类才是 `"error"`。
 */
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
