/**
 * multi-agent v2 扩展 wire format 的守卫(Codex 0.153.4 实测形态)。
 *
 * 这一组钉的是**四个静默失败**——都不报错,却让 subagent 功能整体失效:
 *   1. `function_call` 少 `namespace` 字段 → 客户端 router 按裸名查不到 handler,
 *      回 `unsupported call: spawn_agent`。
 *   2. `NEW_TASK` 信封(父 → 子)被当未知 type 丢弃 → 子线程收到**空 Payload**。
 *   3. `FINAL_ANSWER` 信封(子 → 父)被丢弃 → 父线程模型**看不到子 agent 的答案**。
 *      ★ 最隐蔽的一个:`wait_agent` 的工具结果只有 `{"message":"Wait completed."}`,
 *      不含答案,所以链路全绿、父线程却在空手总结。
 *   4. `MESSAGE` 信封(子 → 父,`send_message`)的 `encrypted_content` 正文被跳过 →
 *      父线程收到空 `Payload:`,把它误读成简短确认(「过早的 OK」)。spawn / NEW_TASK /
 *      FINAL_ANSWER 全部正常,**只有**中间消息丢正文,固定 nonce 端到端返回
 *      `{"message":"EMPTY"}` 才看得出来。
 *
 * 复跑:`test/manual/codex-subagent-probe-server.ts` 打因果对照(哪一半起作用),
 * `test/manual/codex-subagent-lifecycle-server.ts` 打完整生命周期(并发不串线 /
 * followup / interrupt / timeout / fork_turns / 故障重试不重复 spawn / `message`
 * 中间消息正文到达上游)。两个都是真实 Codex CLI + 假 provider,不连上游、不计费。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ReducedAttempt } from '../../../src/claude/non-stream-reduce.js';
import type { SseEvent } from '../../../src/claude/stream.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import { buildResponsesObject } from '../../../src/openai/responses/response-nonstream.js';
import { ResponsesEventEncoder } from '../../../src/openai/responses/response-stream.js';
import type { ResponsesRequest } from '../../../src/openai/responses/types.js';
import { logger } from '../../../src/shared/logger.js';

const COLLAB_TOOLS = [
  'followup_task',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'spawn_agent',
  'wait_agent',
];

function codeModeRequest(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: 'gpt-5.6-sol',
    input: [
      {
        type: 'additional_tools',
        tools: [
          {
            type: 'namespace',
            name: 'functions',
            tools: [{ type: 'custom', name: 'exec', description: 'Run JS' }],
          },
          {
            type: 'namespace',
            name: 'collaboration',
            tools: COLLAB_TOOLS.map((name) => ({
              type: 'function',
              name,
              parameters: { type: 'object', properties: {} },
            })),
          },
        ],
      },
      { role: 'user', content: 'spawn a subagent' },
    ],
    ...overrides,
  };
}

function ev(event: string, data: Record<string, unknown>): SseEvent {
  return { event, data };
}
const MESSAGE_START = ev('message_start', { type: 'message_start', message: {} });
const toolStart = (i: number, id: string, name: string) =>
  ev('content_block_start', {
    index: i,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
const toolStop = (i: number) => ev('content_block_stop', { index: i });
/** 从 SSE 文本里取出所有 function_call item(added 与 done 都算)。 */
function functionCallItems(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = JSON.parse(line.slice(6)) as { item?: Record<string, unknown> };
    if (payload.item?.type === 'function_call') items.push(payload.item);
  }
  return items;
}

function reduced(overrides: Partial<ReducedAttempt> = {}): ReducedAttempt {
  return {
    textContent: '',
    thinkingText: '',
    thinkingSignature: undefined,
    toolUses: [],
    stopReason: 'tool_use',
    inputTokens: 1,
    outputTokens: 1,
    contextInputTokens: undefined,
    kiroMeteringRaw: undefined,
    eventCounts: {},
    upstreamError: undefined,
    hasContent: true,
    ...overrides,
  } as ReducedAttempt;
}

describe('multi-agent v2 — 请求侧', () => {
  it('collaboration 六个工具全部上送,且都记下 namespace', () => {
    const { payload, codec } = convertResponsesRequest(codeModeRequest());
    for (const name of COLLAB_TOOLS) {
      expect(payload.tools?.some((t) => t.name === name)).toBe(true);
      expect(codec.toolNamespaces.get(name)).toBe('collaboration');
    }
    // 默认命名空间按裸名回调:进表就会被错加 namespace,客户端反而找不到 handler。
    expect(codec.toolNamespaces.has('exec')).toBe(false);
  });

  it('namespace 表按请求隔离:两次转换互不影响', () => {
    const withCollab = convertResponsesRequest(codeModeRequest());
    const withoutCollab = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'additional_tools',
          tools: [{ type: 'function', name: 'spawn_agent', parameters: {} }],
        },
      ],
    });
    expect(withCollab.codec.toolNamespaces.get('spawn_agent')).toBe('collaboration');
    // 同名工具这次来自顶层(无 namespace)——共享一份表会让它按 collaboration 错误路由。
    expect(withoutCollab.codec.toolNamespaces.has('spawn_agent')).toBe(false);
  });

  it('tool_choice=none 不留下任何 namespace 映射', () => {
    const { codec } = convertResponsesRequest(codeModeRequest({ tool_choice: 'none' }));
    expect(codec.toolNamespaces.size).toBe(0);
  });
});

describe('multi-agent v2 — 响应侧 namespace 字段', () => {
  const namespaces = new Map([['spawn_agent', 'collaboration']]);

  it('流式:added 与 done 两个 item 都带 namespace,call_id 不被重新生成', () => {
    const encoder = new ResponsesEventEncoder('gpt-5.6-sol', new Set(), namespaces);
    const out = [
      ...encoder.push(MESSAGE_START),
      ...encoder.push(toolStart(0, 'call_upstream_1', 'spawn_agent')),
      ...encoder.push(
        ev('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"task_name":"probe"}' },
        }),
      ),
      ...encoder.push(toolStop(0)),
    ].join('');

    const items = [...out.matchAll(/"item":(\{.*?\}),"sequence_number"/g)].map((m) =>
      JSON.parse(m[1] as string),
    );
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item.type).toBe('function_call');
      expect(item.namespace).toBe('collaboration');
      // 重新生成 call_id 会让客户端把结果配不回这次调用。
      expect(item.call_id).toBe('call_upstream_1');
    }
  });

  it('流式:不在表里的工具不写 namespace 字段(默认命名空间按裸名回调)', () => {
    const encoder = new ResponsesEventEncoder('gpt-5.6-sol', new Set(), namespaces);
    const out = [
      ...encoder.push(MESSAGE_START),
      ...encoder.push(toolStart(0, 'call_x', 'wait')),
      ...encoder.push(toolStop(0)),
    ].join('');
    expect(out).not.toContain('"namespace"');
  });

  it('流式:并行调用各自带对的 namespace,不串线', () => {
    const encoder = new ResponsesEventEncoder(
      'gpt-5.6-sol',
      new Set(),
      new Map([
        ['spawn_agent', 'collaboration'],
        ['other_ns_tool', 'something_else'],
      ]),
    );
    let out = encoder.push(MESSAGE_START).join('');
    for (const [idx, [id, name]] of (
      [
        ['call_a', 'spawn_agent'],
        ['call_b', 'other_ns_tool'],
      ] as const
    ).entries()) {
      out += encoder.push(toolStart(idx, id, name)).join('');
      out += encoder.push(toolStop(idx)).join('');
    }
    // 按 call_id 收敛:每个调用的 namespace 必须始终是自己的那一个,不能相互覆盖。
    const seen = new Map<string, Set<string>>();
    for (const item of functionCallItems(out)) {
      const set = seen.get(item.call_id as string) ?? new Set<string>();
      set.add(String(item.namespace));
      seen.set(item.call_id as string, set);
    }
    expect([...seen.entries()].map(([id, ns]) => [id, [...ns]])).toEqual([
      ['call_a', ['collaboration']],
      ['call_b', ['something_else']],
    ]);
  });

  it('非流式:function_call item 带 namespace,freeform 工具不受影响', () => {
    const obj = buildResponsesObject({
      reduced: reduced({
        toolUses: [
          { type: 'tool_use', id: 'call_1', name: 'spawn_agent', input: { task_name: 'probe' } },
          { type: 'tool_use', id: 'call_2', name: 'exec', input: { input: 'code()' } },
        ] as ReducedAttempt['toolUses'],
      }),
      model: 'gpt-5.6-sol',
      inputTokens: 1,
      outputTokens: 1,
      createdAt: 0,
      customToolNames: new Set(['exec']),
      toolNamespaces: namespaces,
    });
    const spawn = obj.output.find((o) => 'name' in o && o.name === 'spawn_agent');
    expect(spawn).toMatchObject({
      type: 'function_call',
      namespace: 'collaboration',
      call_id: 'call_1',
    });
    // freeform 走 custom_tool_call 分支,那条通道没有 namespace 概念。
    const exec = obj.output.find((o) => 'name' in o && o.name === 'exec');
    expect(exec).toMatchObject({ type: 'custom_tool_call' });
    expect(exec).not.toHaveProperty('namespace');
  });
});

describe('multi-agent v2 — 线程间信封(NEW_TASK / MESSAGE / FINAL_ANSWER)', () => {
  // 默认父 → 子;子 → 父的信封把 author / recipient 反过来传。
  const envelope = (text: string, body: string, author = '/root', recipient = '/root/probe') => ({
    type: 'agent_message' as const,
    author,
    recipient,
    content: [
      { type: 'input_text' as const, text },
      { type: 'encrypted_content' as const, encrypted_content: body },
    ],
  });

  it('NEW_TASK 信封 → user 消息,元信息头与正文都保留且保持顺序', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [envelope('Message Type: NEW_TASK\nPayload:\n', '请回答 SUBAGENT_OK')],
    });
    const msg = payload.messages.at(-1);
    expect(msg?.role).toBe('user');
    expect(msg?.content).toEqual([
      { type: 'text', text: 'Message Type: NEW_TASK\nPayload:\n' },
      { type: 'text', text: '请回答 SUBAGENT_OK' },
    ]);
  });

  it('中文/换行/引号的长正文不被截断或转义改写', () => {
    const body = '第一行"引号"\n第二行\t制表\n'.repeat(40);
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [envelope('Message Type: NEW_TASK\nPayload:\n', body)],
    });
    const blocks = payload.messages.at(-1)?.content;
    expect(Array.isArray(blocks) && blocks[1]).toEqual({ type: 'text', text: body });
  });

  it('★ FINAL_ANSWER(子 → 父)必须转换:否则父线程模型永远看不到子 agent 的答案', () => {
    // wait_agent 的工具结果只有 {"message":"Wait completed.","timed_out":false},
    // **不含**答案本身;答案只走这条信封。丢了它链路全绿、父线程却在空手总结。
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'agent_message',
          author: '/root/probe',
          recipient: '/root',
          content: [
            {
              type: 'input_text',
              text: 'Message Type: FINAL_ANSWER\nSender: /root/probe\nPayload:\nSUBAGENT_OK',
            },
          ],
        },
      ],
    });
    const msg = payload.messages.at(-1);
    expect(msg?.role).toBe('user');
    expect(JSON.stringify(msg?.content)).toContain('SUBAGENT_OK');
    // Sender/Task name 头必须一起留下:只留 Payload,父线程不知道是哪个子 agent 交的活。
    expect(JSON.stringify(msg?.content)).toContain('/root/probe');
  });

  it('★ MESSAGE(子 → 父,send_message)的 encrypted_content 正文必须转明文', () => {
    // 修复前:头留下、正文被当「非 NEW_TASK 的 encrypted_content」跳过 → 父线程只见空
    // `Payload:`,把它误读成一句简短确认。固定 nonce 端到端返回 {"message":"EMPTY"}。
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        envelope(
          'Message Type: MESSAGE\nSender: /root/probe\nPayload:\n',
          'MESSAGE_NONCE_7F3A',
          '/root/probe',
          '/root',
        ),
      ],
    });
    const msg = payload.messages.at(-1);
    expect(msg?.role).toBe('user');
    expect(msg?.content).toEqual([
      { type: 'text', text: 'Message Type: MESSAGE\nSender: /root/probe\nPayload:\n' },
      { type: 'text', text: 'MESSAGE_NONCE_7F3A' },
    ]);
    // author / recipient 是客户端侧路由信息,不进模型上下文。
    expect(msg).not.toHaveProperty('author');
    expect(msg).not.toHaveProperty('recipient');
  });

  it('两个子 agent 并发发 MESSAGE:各自正文跟各自的头走,顺序保持、不串线', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        envelope(
          'Message Type: MESSAGE\nSender: /root/alpha\nPayload:\n',
          'NONCE_ALPHA',
          '/root/alpha',
          '/root',
        ),
        envelope(
          'Message Type: MESSAGE\nSender: /root/beta\nPayload:\n',
          'NONCE_BETA',
          '/root/beta',
          '/root',
        ),
      ],
    });
    expect(payload.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Message Type: MESSAGE\nSender: /root/alpha\nPayload:\n' },
          { type: 'text', text: 'NONCE_ALPHA' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Message Type: MESSAGE\nSender: /root/beta\nPayload:\n' },
          { type: 'text', text: 'NONCE_BETA' },
        ],
      },
    ]);
  });

  it('Message Type 按整个 token 比对:MESSAGE_V2 这类前缀相同的类型不在白名单里', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        envelope(
          'Message Type: MESSAGE_V2\nPayload:\n',
          'PREFIX_COLLISION_BODY',
          '/root/probe',
          '/root',
        ),
      ],
    });
    // 信封本身仍转发(头留下),但正文语义未知、不转明文。
    expect(JSON.stringify(payload.messages)).toContain('MESSAGE_V2');
    expect(JSON.stringify(payload.messages)).not.toContain('PREFIX_COLLISION_BODY');
  });

  it('日志只记类型与是否转了正文,绝不记 Payload / 正文', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      convertResponsesRequest({
        model: 'gpt-5.6-sol',
        input: [
          envelope(
            'Message Type: MESSAGE\nSender: /root/probe\nPayload:\n',
            'SECRET_BODY_MUST_NOT_LOG',
            '/root/probe',
            '/root',
          ),
        ],
      });
      const envelopeLogs = spy.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((f) => f?.msg === 'responses: converted multi-agent envelope');
      expect(envelopeLogs).toHaveLength(1);
      const fields = envelopeLogs[0] as Record<string, unknown>;
      expect(fields.message_type).toBe('MESSAGE');
      expect(fields.body_converted).toBe(true);
      expect(JSON.stringify(fields)).not.toContain('SECRET_BODY_MUST_NOT_LOG');
      expect(JSON.stringify(fields)).not.toContain('Payload:');
    } finally {
      spy.mockRestore();
    }
  });

  it('未知 Message Type 的信封也转发(丢弃 = 模型失明,是更糟的失败模式)', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'agent_message',
          author: '/root/probe',
          recipient: '/root',
          content: [
            { type: 'input_text', text: 'Message Type: SOME_FUTURE_KIND\nPayload:\nhello' },
          ],
        },
      ],
    });
    expect(JSON.stringify(payload.messages)).toContain('hello');
  });

  it('★ 白名单外信封(FINAL_ANSWER 等)的 encrypted_content 不转明文(语义未知,转出去是泄漏)', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        envelope(
          'Message Type: FINAL_ANSWER\nPayload:\n',
          'PRIVATE_SIDE_CHANNEL',
          '/root/probe',
          '/root',
        ),
      ],
    });
    // FINAL_ANSWER 实测正文在 input_text 的 Payload 段,不走 encrypted_content;若某天它也
    // 带了这个字段,语义未知,不转——要扩白名单先抓脱敏 fixture 确认(见 converter.ts)。
    // 信封本身转了(头留下),但那段私有内容没有跟进模型上下文。
    expect(JSON.stringify(payload.messages)).toContain('FINAL_ANSWER');
    expect(JSON.stringify(payload.messages)).not.toContain('PRIVATE_SIDE_CHANNEL');
  });

  it('★ 判据必须窄:没有结构化 Message Type 头的 agent_message 整条不转换', () => {
    // 转发的门槛是「有信封头」。没有头就不是本协议的东西,语义未知,不塞进模型上下文。
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        envelope('just some chatter', 'PRIVATE_STATE', '/root', '/root/other'),
        { role: 'user', content: 'go' },
      ],
    });
    expect(JSON.stringify(payload.messages)).not.toContain('PRIVATE_STATE');
    expect(payload.messages).toEqual([{ role: 'user', content: 'go' }]);
  });

  it('★ reasoning.encrypted_content 仍然绝不出明文(那是真密文,不是任务正文)', () => {
    const { payload } = convertResponsesRequest({
      model: 'gpt-5.6-sol',
      input: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'OPAQUE_CIPHERTEXT' },
        { role: 'user', content: 'go' },
      ],
    });
    expect(JSON.stringify(payload.messages)).not.toContain('OPAQUE_CIPHERTEXT');
  });
});
