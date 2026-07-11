/**
 * 泄漏工具调用文本救援（claude/tool-call-text.ts）。
 *
 * 场景：上游偶发把模型的工具调用当纯文本从 assistantResponseEvent 发下来
 * （而非结构化 toolUseEvent）。检测器要把格式完整的泄漏块解析回 tool_use，
 * 同时对普通文本做到逐字节透传（误报 = 幻影工具执行，代价极高）。
 *
 * 注意：测试样例里的命名空间前缀变体全部动态拼接（NS_PREFIX），与实现同理——
 * 测试文件本身也不包含字面的前缀标记序列。
 */

import { describe, expect, it } from 'vitest';
import { convertRequest } from '../../src/claude/converter.js';
import { type SseEvent, StreamContext } from '../../src/claude/stream.js';
import {
  buildToolTextRegistry,
  type DetectorItem,
  extractToolCallsFromCompleteText,
  ToolCallTextDetector,
} from '../../src/claude/tool-call-text.js';
import type { MessagesRequest, Tool } from '../../src/claude/types.js';
import { HookBus } from '../../src/plugin-host/index.js';

/** 命名空间前缀，动态拼接（理由见文件头） */
const NS_PREFIX = ['ant', 'ml'].join('');

const TOOLS: Tool[] = [
  {
    name: 'Edit',
    description: 'edit a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Read',
    description: 'read a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'TodoWrite',
    description: 'todos',
    input_schema: {
      type: 'object',
      properties: { todos: { type: 'array' } },
    },
  },
];

const REGISTRY = buildToolTextRegistry(TOOLS);

/** 用户实际观测到的泄漏形态：无 wrapper、裸 invoke、参数值含中文多行文本 */
const LEAK_EDIT = [
  '<invoke name="Edit">',
  '<parameter name="file_path">/repo/notes/draft.md</parameter>',
  `<parameter name="old_string">1. 第一章：多行中文段落，\n   含逗号、顿号与换行，用于精确字节匹配</parameter>`,
  `<parameter name="new_string">1. 第一章（修订）：多行中文段落，\n   验证参数值逐字节透传</parameter>`,
  '</invoke>',
].join('\n');

function extract(text: string) {
  return extractToolCallsFromCompleteText(text, REGISTRY);
}

// ============================================================================
// 完整文本提取
// ============================================================================

describe('extractToolCallsFromCompleteText', () => {
  it('无标记文本逐字节透传', () => {
    const text = '普通回复，包含 <b> 标签、`代码`、\n多行内容，以及 100 < 200 的比较。';
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('救援用户观测到的裸 invoke 泄漏形态（含中文多行参数值）', () => {
    const r = extract(`我来修改这段文字。\n${LEAK_EDIT}\n`);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe('Edit');
    expect(r.calls[0].input.file_path).toBe('/repo/notes/draft.md');
    // string 参数逐字节保留（Edit 的 old_string 需要精确匹配）
    expect(r.calls[0].input.old_string).toContain('含逗号、顿号与换行，用于精确字节匹配');
    expect(String(r.calls[0].input.old_string)).toMatch(/^1\. 第一章/);
    expect(r.text).toBe('我来修改这段文字。\n');
  });

  it('救援带 wrapper 的多 invoke 块', () => {
    const text = [
      '<function_calls>',
      '<invoke name="Read">',
      '<parameter name="file_path">/tmp/a.txt</parameter>',
      '<parameter name="offset">100</parameter>',
      '</invoke>',
      '<invoke name="Edit">',
      '<parameter name="file_path">/tmp/b.txt</parameter>',
      '<parameter name="old_string">x</parameter>',
      '<parameter name="new_string">y</parameter>',
      '<parameter name="replace_all">true</parameter>',
      '</invoke>',
      '</function_calls>',
      '',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[0].name).toBe('Read');
    // integer 参数按 schema 还原
    expect(r.calls[0].input.offset).toBe(100);
    expect(r.calls[1].input.replace_all).toBe(true);
    expect(r.text.trim()).toBe('');
  });

  it('救援命名空间前缀变体', () => {
    const text = [
      `<${NS_PREFIX}:invoke name="Read">`,
      `<${NS_PREFIX}:parameter name="file_path">/tmp/x</${NS_PREFIX}:parameter>`,
      `</${NS_PREFIX}:invoke>`,
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.file_path).toBe('/tmp/x');
  });

  it('array 类型参数按 JSON 还原', () => {
    const text = [
      '<invoke name="TodoWrite">',
      '<parameter name="todos">[{"content":"步骤一","status":"pending"}]</parameter>',
      '</invoke>',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.todos).toEqual([{ content: '步骤一', status: 'pending' }]);
  });

  it('参数值里的闭合标签字面量不误切（lookahead 门）', () => {
    const evil = '文档里写着 </parameter> 这个词但后面不是标签';
    const text = [
      '<invoke name="Edit">',
      '<parameter name="file_path">/tmp/doc.md</parameter>',
      `<parameter name="old_string">${evil}</parameter>`,
      '<parameter name="new_string">替换后</parameter>',
      '</invoke>',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.old_string).toBe(evil);
  });

  it('未注册的工具名不触发（原样透传）', () => {
    const text = [
      '<invoke name="NotARealTool">',
      '<parameter name="x">1</parameter>',
      '</invoke>',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('代码围栏内的示例不触发', () => {
    const text = ['看这个例子：', '```', LEAK_EDIT, '```', '就是这样。'].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('波浪线围栏（~~~）内的示例不触发', () => {
    const text = ['例子：', '~~~', LEAK_EDIT, '~~~', '完。'].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('围栏内带尾随文字的 ``` 行不闭合围栏（CommonMark 语义）', () => {
    const text = ['```', '``` 这行有尾随文字，不是闭围栏', LEAK_EDIT, '```', '完。'].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('反引号围栏不被 ~~~ 行闭合（围栏字符必须匹配）', () => {
    const text = ['```', '~~~', LEAK_EDIT, '```', '完。'].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('4+ 反引号围栏内的裸 ``` 行不闭合围栏（CommonMark 闭围栏长度必须 ≥ 开围栏）', () => {
    // 模型引用「本身含 ``` 代码块的 markdown」的标准写法就是 ```` 外层围栏——
    // 修复前 ``` 内容行会误关外层围栏,其后的示例块被误救援/误剥
    const text = ['引用一份文档：', '````markdown', '```', LEAK_EDIT, '```', '````', '完。'].join(
      '\n',
    );
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('~~~~ 围栏内的裸 ~~~ 行同样不闭合围栏', () => {
    const text = ['例：', '~~~~', '~~~', LEAK_EDIT, '~~~', '~~~~', '完。'].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('CRLF 行尾的围栏行照常开合（行尾 \\r 剥掉再判）', () => {
    const text = `看这个例子：\r\n\`\`\`\r\n${LEAK_EDIT.replaceAll('\n', '\r\n')}\r\n\`\`\`\r\n完。`;
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('列表项同行围栏（- ```）内 2 空格缩进的示例不触发', () => {
    const indented = LEAK_EDIT.split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    const text = `格式演示：\n- \`\`\`\n${indented}\n  \`\`\`\n讲解完。\n`;
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('列表标记后为 tab 的同行围栏（-\\t```）同样开围栏', () => {
    const indented = LEAK_EDIT.split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    const text = `演示：\n-\t\`\`\`\n${indented}\n  \`\`\`\n完。\n`;
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('info string 含反引号的 ``` 行不开围栏（CommonMark：那是普通段落）→ 其后真实泄漏仍被救援', () => {
    const text = `\`\`\` 的用法见 \`README\` 一节。\n${LEAK_EDIT}\n`;
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe('Edit');
  });

  it('4 空格缩进代码块里的示例不触发（且逐字节透传，不丢内容）', () => {
    const indented = LEAK_EDIT.split('\n')
      .map((l) => `    ${l}`)
      .join('\n');
    const text = `格式示例：\n\n${indented}\n\n后续散文继续。\n`;
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('参数之间有空行/缩进的泄漏仍被正确解析（空白容忍对称）', () => {
    const text = [
      '<invoke name="Edit">',
      '<parameter name="file_path">/tmp/a.md</parameter>',
      '',
      '  <parameter name="old_string">旧内容</parameter>',
      '',
      '<parameter name="new_string">新内容</parameter>',
      '</invoke>',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].input.old_string).toBe('旧内容');
    expect(r.calls[0].input.new_string).toBe('新内容');
  });

  it('非行首的引用不触发', () => {
    const text = '模型有时会输出 <invoke name="Edit"> 这样的标记，属于泄漏。';
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('语法不完整的块原样透传（invoke 开标签后跟普通文本）', () => {
    const text = '<invoke name="Edit">\n然后我们聊聊别的。\n';
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('大量假触发不爆栈（迭代驱动回归测试）：每行一个断裂的 invoke 开头', () => {
    // 递归实现会在这里 Maximum call stack size exceeded
    const text = '<invoke name="Edit">\n随便说点。\n'.repeat(2000);
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('参数值里嵌完整 invoke 块字面量（lookahead 取最内层闭合，调用仍被救援）', () => {
    const inner = '<invoke name="Edit">\n<parameter name="file_path">/inner</parameter>\n</invoke>';
    const text = `<invoke name="Edit">\n<parameter name="file_path">${inner}</parameter>\n</invoke>`;
    const r = extract(text);
    // 值内嵌套标记属于语法歧义:能救出一个 Edit 调用即可,不追求嵌套语义
    expect(r.calls.length).toBeGreaterThanOrEqual(1);
    expect(r.calls[0].name).toBe('Edit');
  });

  it('流尾截断的悬空块按文本原样保留（永不丢弃：无法证明是泄漏就不能丢）', () => {
    const text = `好的，开始修改：\n<invoke name="Edit">\n<parameter name="file_path">/tmp/a`;
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('悬空前缀之后的正常散文一并保留（capture 吞进的内容绝不静默丢失）', () => {
    // 完整 parameter 闭合后跟散文（而非下一个标签）→ lookahead 永不闭合,
    // capture 一路吞到 EOF——修复前这里的散文会被 dropDangling 整段删除
    const text = [
      '解释一下泄漏长什么样。',
      '<invoke name="Edit">',
      '<parameter name="file_path">/tmp/x</parameter>',
      '之后是完全正常的分析文字，必须逐字节保留。',
      '部署密钥已轮换到 v7。',
    ].join('\n');
    const r = extract(text);
    expect(r.calls).toHaveLength(0);
    expect(r.text).toBe(text);
  });

  it('块后的普通文本保留', () => {
    const text = `${LEAK_EDIT}\n修改完成。\n`;
    const r = extract(text);
    expect(r.calls).toHaveLength(1);
    expect(r.text).toBe('修改完成。\n');
  });

  it('长工具名的缩短名可被识别', () => {
    const longName = `mcp__${'x'.repeat(70)}__do_thing`;
    const registry = buildToolTextRegistry([
      {
        name: longName,
        description: '',
        input_schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ]);
    // 模型视角只见过缩短名（converter 上送前缩短）
    const shortName = [...registry.paramTypes.keys()].find((k) => k !== longName);
    expect(shortName).toBeDefined();
    const text = [
      `<invoke name="${shortName}">`,
      '<parameter name="a">v</parameter>',
      '</invoke>',
    ].join('\n');
    const r = extractToolCallsFromCompleteText(text, registry);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].name).toBe(shortName);
  });
});

// ============================================================================
// 流式检测器（分块一致性）
// ============================================================================

function feedChunked(text: string, chunkSize: number): DetectorItem[] {
  const det = new ToolCallTextDetector(REGISTRY);
  const items: DetectorItem[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    items.push(...det.feed(text.slice(i, i + chunkSize)));
  }
  items.push(...det.flush());
  return items;
}

function joinItems(items: DetectorItem[]): { text: string; calls: string[] } {
  let text = '';
  const calls: string[] = [];
  for (const it of items) {
    if (it.type === 'text') text += it.text;
    else calls.push(it.call.name);
  }
  return { text, calls };
}

describe('ToolCallTextDetector（流式）', () => {
  const sample = `前置说明。\n${LEAK_EDIT}\n后续文本。\n`;

  it.each([1, 3, 7, 17, 64, 4096])('分块大小 %d 与完整文本结果一致', (size) => {
    const { text, calls } = joinItems(feedChunked(sample, size));
    expect(calls).toEqual(['Edit']);
    expect(text).toBe('前置说明。\n后续文本。\n');
  });

  it.each([1, 5, 23])('纯文本按分块 %d 逐字节透传', (size) => {
    const plain = '第一行 <tag> 内容\n```\n<invoke name="Edit">\n```\n右侧 a < b 比较。\n';
    const { text, calls } = joinItems(feedChunked(plain, size));
    expect(calls).toEqual([]);
    expect(text).toBe(plain);
  });

  it('跨 chunk 的代码围栏状态正确（围栏内不触发）', () => {
    const det = new ToolCallTextDetector(REGISTRY);
    const items: DetectorItem[] = [];
    items.push(...det.feed('```\n<invoke name='));
    items.push(...det.feed('"Edit">\n</invoke>\n```\n'));
    items.push(...det.flush());
    const { text, calls } = joinItems(items);
    expect(calls).toEqual([]);
    expect(text).toBe('```\n<invoke name="Edit">\n</invoke>\n```\n');
  });

  it('解析预算熔断：病态假闭合内容超预算后退化为纯透传（逐字节不丢内容）', () => {
    // 大量「假 </parameter> 字面量 + 永不真闭合」按小帧流入 = 二次方重解析
    // 的最坏形态。budget=0 让熔断在首个计到 ≥1ms 的解析后触发;无论是否
    // 触发,行为不变量都必须成立:零调用 + 逐字节透传（熔断只降级,不丢弃）
    const decoys = Array.from({ length: 800 }, (_, i) => `row${i} </parameter> tail`).join('\n');
    const text = `<invoke name="Edit">\n<parameter name="old_string">${decoys}`;
    const det = new ToolCallTextDetector(REGISTRY, { parseBudgetMs: 0 });
    const items: DetectorItem[] = [];
    for (let i = 0; i < text.length; i += 64) {
      items.push(...det.feed(text.slice(i, i + 64)));
    }
    items.push(...det.flush());
    const { text: out, calls } = joinItems(items);
    expect(calls).toEqual([]);
    expect(out).toBe(text);
  });

  it('熔断只阻止后续触发：本次扫描已定型的救援照常交付，之后纯透传', () => {
    const det = new ToolCallTextDetector(REGISTRY, { parseBudgetMs: -1 });
    const items: DetectorItem[] = [];
    // parseBudgetMs=-1:首次解析即熔断（elapsed ≥ 0 > -1）。同一次扫描里
    // 第一个块已完整定型（done）→ 照常救援;熔断使第二个块不再触发。
    items.push(...det.feed(`${LEAK_EDIT}\n之后的文本。\n${LEAK_EDIT}\n`));
    items.push(...det.flush());
    const { text, calls } = joinItems(items);
    expect(calls).toEqual(['Edit']);
    expect(text).toBe(`之后的文本。\n${LEAK_EDIT}\n`);
  });

  it('flush 时悬空的截断块按文本吐回、已完整的 invoke 正常救援', () => {
    const det = new ToolCallTextDetector(REGISTRY);
    const items: DetectorItem[] = [];
    items.push(
      ...det.feed(`${LEAK_EDIT}\n<invoke name="Read">\n<parameter name="file_path">/tmp/半个调`),
    );
    items.push(...det.flush());
    const { text, calls } = joinItems(items);
    expect(calls).toEqual(['Edit']);
    expect(text).toBe('<invoke name="Read">\n<parameter name="file_path">/tmp/半个调');
  });
});

// ============================================================================
// StreamContext 集成（SSE 事件形态）
// ============================================================================

function collectText(events: SseEvent[]): string {
  return events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => ((e.data.delta as Record<string, unknown>)?.text as string) ?? '')
    .join('');
}

function collectToolStarts(events: SseEvent[]): Array<Record<string, unknown>> {
  return events
    .filter(
      (e) =>
        e.event === 'content_block_start' &&
        (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
    )
    .map((e) => e.data.content_block as Record<string, unknown>);
}

describe('StreamContext 泄漏救援集成', () => {
  it('泄漏文本流式到达 → tool_use block + stop_reason=tool_use', async () => {
    const ctx = new StreamContext('test-model', 1, false, new Map(), new HookBus(), REGISTRY);
    const events: SseEvent[] = [...ctx.generateInitialEvents()];
    // 模拟上游把泄漏文本按帧发下来
    const full = `我来修改。\n${LEAK_EDIT}`;
    for (let i = 0; i < full.length; i += 40) {
      events.push(
        ...ctx.processKiroEvent({ kind: 'AssistantResponse', content: full.slice(i, i + 40) }),
      );
    }
    events.push(...(await ctx.generateFinalEvents()));

    const toolStarts = collectToolStarts(events);
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].name).toBe('Edit');
    expect(collectText(events)).toBe('我来修改。\n');

    const messageDelta = events.find((e) => e.event === 'message_delta');
    expect((messageDelta?.data.delta as Record<string, unknown>)?.stop_reason).toBe('tool_use');

    // input_json_delta 里的 JSON 可解析且参数完整
    const inputJson = events
      .filter(
        (e) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type === 'input_json_delta',
      )
      .map((e) => (e.data.delta as Record<string, unknown>).partial_json as string)
      .join('');
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    expect(input.file_path).toBe('/repo/notes/draft.md');
  });

  it('检测器缓冲中途遇到真实 toolUseEvent：缓冲文本先按文本吐出，时序正确', async () => {
    const ctx = new StreamContext('test-model', 1, false, new Map(), new HookBus(), REGISTRY);
    const events: SseEvent[] = [...ctx.generateInitialEvents()];
    // 文本以合法块前缀结尾（检测器进入 capture 等更多数据）……
    events.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: '看起来像块开头：\n<invoke name="Edit">\n<parameter name="file_path">/tmp/x',
      }),
    );
    // ……然后到达的是真实的结构化 toolUseEvent
    events.push(
      ...ctx.processKiroEvent({
        kind: 'ToolUse',
        name: 'Read',
        toolUseId: 'tool-1',
        input: '{"file_path":"/tmp/y"}',
        isComplete: true,
      }),
    );
    events.push(...(await ctx.generateFinalEvents()));

    // 悬空候选按文本吐回（不丢内容），且出现在真实 tool_use 之前
    const text = collectText(events);
    expect(text).toContain('<invoke name="Edit">');
    const toolStarts = collectToolStarts(events);
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].name).toBe('Read');
    const firstToolIdx = events.findIndex(
      (e) =>
        e.event === 'content_block_start' &&
        (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
    );
    const lastTextIdx = events
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e }) =>
          e.event === 'content_block_delta' &&
          (e.data.delta as Record<string, unknown>)?.type === 'text_delta',
      )
      .map(({ i }) => i)
      .pop();
    expect(lastTextIdx).toBeLessThan(firstToolIdx);
  });

  it('纯截断泄漏流：悬空块按文本吐回，不产出零内容消息', async () => {
    const ctx = new StreamContext('test-model', 1, false, new Map(), new HookBus(), REGISTRY);
    const events: SseEvent[] = [...ctx.generateInitialEvents()];
    const truncated = '<invoke name="Edit">\n<parameter name="file_path">/tmp/a';
    events.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: truncated }));
    events.push(...(await ctx.generateFinalEvents()));
    expect(collectToolStarts(events)).toHaveLength(0);
    expect(collectText(events)).toBe(truncated);
  });

  it('救援关闭（无 registry）时泄漏文本原样透传', async () => {
    const ctx = new StreamContext('test-model', 1, false, new Map(), new HookBus());
    const events: SseEvent[] = [...ctx.generateInitialEvents()];
    events.push(...ctx.processKiroEvent({ kind: 'AssistantResponse', content: LEAK_EDIT }));
    events.push(...(await ctx.generateFinalEvents()));
    expect(collectToolStarts(events)).toHaveLength(0);
    expect(collectText(events)).toBe(LEAK_EDIT);
  });

  it('救援出的缩短名经 toolNameMap 反映射回原名', async () => {
    const longName = `mcp__${'y'.repeat(70)}__do_thing`;
    const registry = buildToolTextRegistry([
      {
        name: longName,
        description: '',
        input_schema: { type: 'object', properties: { a: { type: 'string' } } },
      },
    ]);
    const shortName = [...registry.paramTypes.keys()].find((k) => k !== longName) as string;
    const toolNameMap = new Map([[shortName, longName]]);
    const ctx = new StreamContext('test-model', 1, false, toolNameMap, new HookBus(), registry);
    const events: SseEvent[] = [...ctx.generateInitialEvents()];
    events.push(
      ...ctx.processKiroEvent({
        kind: 'AssistantResponse',
        content: `<invoke name="${shortName}">\n<parameter name="a">v</parameter>\n</invoke>`,
      }),
    );
    events.push(...(await ctx.generateFinalEvents()));
    const toolStarts = collectToolStarts(events);
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0].name).toBe(longName);
  });
});

// ============================================================================
// converter 历史去污染
// ============================================================================

describe('converter 历史去污染', () => {
  function makeRequest(assistantText: string): MessagesRequest {
    return {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        { role: 'user', content: '改一下文件' },
        { role: 'assistant', content: assistantText },
        { role: 'user', content: '工具调用变成文本了，重试' },
      ],
    } as MessagesRequest;
  }

  function historyAssistantContents(req: MessagesRequest): string[] {
    const { conversationState } = convertRequest(req, { toolTextRegistry: REGISTRY });
    return conversationState.history
      .filter((m) => m.kind === 'assistant')
      .map((m) => (m.kind === 'assistant' ? m.assistantResponseMessage.content : ''));
  }

  it('assistant 历史里的泄漏块被剥掉', () => {
    const contents = historyAssistantContents(makeRequest(`我来修改。\n${LEAK_EDIT}`));
    const target = contents.find((c) => c.includes('我来修改')) ?? '';
    expect(target).toBe('我来修改。\n');
    expect(target).not.toContain('invoke');
  });

  it('整条消息都是泄漏块时用空格占位（Kiro 要求 content 非空）', () => {
    const { conversationState } = convertRequest(makeRequest(LEAK_EDIT), {
      toolTextRegistry: REGISTRY,
    });
    const assistants = conversationState.history.filter((m) => m.kind === 'assistant');
    for (const m of assistants) {
      if (m.kind !== 'assistant') continue;
      expect(m.assistantResponseMessage.content.length).toBeGreaterThan(0);
      expect(m.assistantResponseMessage.content).not.toContain('invoke');
    }
  });

  it('块数组形式的 assistant 历史剥空后同样占位（Claude Code 的历史都是块数组）', () => {
    const req: MessagesRequest = {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        { role: 'user', content: '改一下' },
        { role: 'assistant', content: [{ type: 'text', text: LEAK_EDIT }] },
        { role: 'user', content: '重试' },
      ],
    } as MessagesRequest;
    const { conversationState } = convertRequest(req, { toolTextRegistry: REGISTRY });
    const assistants = conversationState.history.filter((m) => m.kind === 'assistant');
    for (const m of assistants) {
      if (m.kind !== 'assistant') continue;
      expect(m.assistantResponseMessage.content.length).toBeGreaterThan(0);
      expect(m.assistantResponseMessage.content).not.toContain('invoke');
    }
  });

  it('两条连续 assistant 都被剥空时，合并后的 content 仍非空（不产出空 content 上送 Kiro）', () => {
    // 被污染会话可能连续多轮 assistant 都是纯泄漏块。去污染把每条剥成占位 ' '，
    // mergeAssistantMessages 合并 2+ 条时 line 879 的 .trim() 会丢掉占位——若无
    // 全空守卫会落到 [].join('\n\n') = '' 违反 Kiro 非空约束。
    const req: MessagesRequest = {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        { role: 'user', content: '改两个文件' },
        { role: 'assistant', content: LEAK_EDIT },
        {
          role: 'assistant',
          content:
            '<invoke name="Read">\n<parameter name="file_path">/tmp/y</parameter>\n</invoke>',
        },
        { role: 'user', content: '重试' },
      ],
    } as MessagesRequest;
    const { conversationState } = convertRequest(req, { toolTextRegistry: REGISTRY });
    for (const m of conversationState.history) {
      if (m.kind !== 'assistant') continue;
      expect(m.assistantResponseMessage.content.length).toBeGreaterThan(0);
      expect(m.assistantResponseMessage.content).not.toContain('invoke');
    }
  });

  it('悬空前缀之后的散文在历史里完整保留（不再被丢弃语义吞掉）', () => {
    const withProse = [
      '讲一下泄漏。',
      '<invoke name="Edit">',
      '<parameter name="file_path">/tmp/x</parameter>',
      '后续分析文字必须保留。',
    ].join('\n');
    const contents = historyAssistantContents(makeRequest(withProse));
    const target = contents.find((c) => c.includes('讲一下泄漏')) ?? '';
    expect(target).toContain('后续分析文字必须保留。');
    expect(target).toContain('<invoke name="Edit">');
  });

  it('围栏跨同一消息的两个 text 块时，第二块围栏内的示例不被剥（围栏状态共享）', () => {
    const req: MessagesRequest = {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools: TOOLS,
      messages: [
        { role: 'user', content: '演示一下' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '格式示例如下：\n```\n' },
            { type: 'text', text: `${LEAK_EDIT}\n\`\`\`\n讲解完。` },
          ],
        },
        { role: 'user', content: '继续' },
      ],
    } as MessagesRequest;
    const { conversationState } = convertRequest(req, { toolTextRegistry: REGISTRY });
    const joined = conversationState.history
      .filter((m) => m.kind === 'assistant')
      .map((m) => (m.kind === 'assistant' ? m.assistantResponseMessage.content : ''))
      .join('');
    expect(joined).toContain('invoke name="Edit"');
    expect(joined).toContain('讲解完。');
  });

  it('围栏内的示例不被剥（假泄漏保留）', () => {
    const fenced = ['讲解一下：', '```', LEAK_EDIT, '```'].join('\n');
    const contents = historyAssistantContents(makeRequest(fenced));
    const target = contents.find((c) => c.includes('讲解一下')) ?? '';
    expect(target).toContain('invoke name="Edit"');
  });

  it('选项关闭时不改动历史', () => {
    const req = makeRequest(`我来修改。\n${LEAK_EDIT}`);
    const { conversationState } = convertRequest(req, {});
    const assistants = conversationState.history.filter((m) => m.kind === 'assistant');
    const target = assistants
      .map((m) => (m.kind === 'assistant' ? m.assistantResponseMessage.content : ''))
      .find((c) => c.includes('我来修改'));
    expect(target).toContain('invoke name="Edit"');
  });

  it('user 消息里的相同文本永不触碰', () => {
    const req: MessagesRequest = {
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      tools: TOOLS,
      messages: [{ role: 'user', content: `你的输出坏了：\n${LEAK_EDIT}` }],
    } as MessagesRequest;
    const { conversationState } = convertRequest(req, { toolTextRegistry: REGISTRY });
    expect(conversationState.currentMessage.userInputMessage.content).toContain(
      'invoke name="Edit"',
    );
  });
});

// ============================================================================
// 请求侧去污染的纯文本视图（extractToolCallsFromCompleteText(...).text）
// ============================================================================

describe('extractToolCallsFromCompleteText 的 .text（去污染视图）', () => {
  it('剥掉完整泄漏块；截断尾巴按文本保留（永不丢弃）', () => {
    const text = `分析如下。\n${LEAK_EDIT}\n<invoke name="Read">\n<parameter name="file_path">/tmp/半`;
    expect(extract(text).text).toBe(
      '分析如下。\n<invoke name="Read">\n<parameter name="file_path">/tmp/半',
    );
  });

  it('无泄漏时返回原引用等价文本', () => {
    const text = '完全正常的回复。\n第二行。';
    expect(extract(text).text).toBe(text);
  });
});
