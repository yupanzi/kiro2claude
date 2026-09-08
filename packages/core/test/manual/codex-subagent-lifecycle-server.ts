/**
 * Codex multi-agent v2 **生命周期**闭环:真实网关 + 真实 Codex CLI,假 provider,不计费。
 *
 * 与 `codex-subagent-probe-server.ts` 的分工:那个证明「router 受理调用」这**一步**;
 * 这个跑完整的 spawn → 子线程执行 → wait → 结果回到父线程,并覆盖并发/followup/
 * interrupt/timeout/fork_turns/故障重试/子 → 父中间消息(`message`)。agent 生命周期由
 * **客户端**实现,探针只扮演模型。
 *
 * `message` 场景的判据是**正文到达上游**:子线程调 `send_message` 给父线程发一个中间
 * nonce,客户端把它包成 `Message Type: MESSAGE` 信封(正文在 `encrypted_content`)送进
 * 父线程的下一次请求;网关若只转 `NEW_TASK` 的正文,父线程模型看到的是空 `Payload:`。
 * 所以要对照两处:信封在网关**入口**带着正文(客户端没丢)vs 转换后的**上游请求**
 * 仍带着它(网关没丢)。前有后无 = 网关吞了正文。
 *
 * ★ 判据是 **nonce 配对**,不是「有没有报错」:每个 spawn 的任务正文里埋一个唯一 nonce,
 * 子线程必须原样回它,父线程的 `wait_agent` 结果里必须出现**对应那一个**。串线(A 的
 * 结果落到 B 的 call_id 上)靠这个才看得见——只看「都成功了」是看不出来的。
 *
 * 父/子线程判别只看**结构**:请求里带 NEW_TASK 信封的就是子线程,不看模型名或轮次。
 *
 * 运行:
 *   K2C_LIFECYCLE_PORT=18962 pnpm --filter @kiro2claude/core exec tsx \
 *     test/manual/codex-subagent-lifecycle-server.ts
 * 客户端须开 `agents.enabled = true`,命令行见 tools/codex/README.md。
 * 结束时 Ctrl-C,报告落 K2C_LIFECYCLE_REPORT_DIR。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { ProviderError } from '../../src/kiro/provider-error.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import {
  buildAssistantResponseFrame,
  buildToolUseFrame,
  completedFrames,
} from '../helpers/event-stream.js';

type Obj = Record<string, any>;

const reportDir = resolve(
  process.env.K2C_LIFECYCLE_REPORT_DIR ?? '../../test-results/codex-subagent-lifecycle',
);
await mkdir(reportDir, { recursive: true });

const SCENARIOS = [
  'single',
  'concurrent',
  'followup',
  'interrupt',
  'timeout',
  'fork-turns',
  'fault-retry',
  'message',
] as const;
type Scenario = (typeof SCENARIOS)[number];

/**
 * 按 **nonce** 记账,不按 agent:followup 会给同一个 agent 派第二个任务,按 agent 记
 * 会把「两个任务各送达一次」误报成「同一任务重复送达」。每个 nonce 恰好一次投递、
 * 一次回收,才是正确形态。
 */
interface NonceRecord {
  taskName: string;
  nonce: string;
  /** 子线程收到该 nonce 的次数。>1 = 故障重试重复投递了子任务。 */
  deliveries: number;
  /** 父线程在 FINAL_ANSWER 信封里收到该 nonce 的次数。 */
  observedByParent: number;
  /** 送回该 nonce 的信封 author。与 taskName 不符 = 串线。 */
  answeredBy: string[];
}

/**
 * `message` 场景的中间消息记账。nonce 与任务 nonce 不同,只经 `send_message` 这一条路
 * 到父线程;各计数按**父线程请求**累计(历史会重复携带信封,所以 >1 是正常的)。
 */
interface IntermediateRecord {
  nonce: string;
  /** 子线程发出 send_message 时用的 call_id;它的回执回来 = 该交最终答案了。 */
  sendCallId: string;
  /** 子线程实际派发 send_message 的次数(应为 1)。 */
  sentBySub: number;
  /** 父线程请求里出现 `Message Type: MESSAGE` 信封的次数。 */
  envelopeSeenByParent: number;
  /** 其中 `encrypted_content` 正文含中间 nonce 的次数(客户端侧没丢)。 */
  envelopeBodyPresent: number;
  /** 转换后的上游请求里含中间 nonce 的次数(网关侧没丢)。 */
  reachedUpstream: number;
  /** 入口带正文、上游却没有的次数。>0 = 网关吞了正文,是本场景唯一的失败判据。 */
  lostAtGateway: number;
}

interface RunState {
  scenario: Scenario;
  requests: number;
  /** key = nonce。 */
  agents: Map<string, NonceRecord>;
  /** 只在 `message` 场景存在。 */
  intermediate?: IntermediateRecord;
  /** 已派发但还没在 call_output 里见到回执的调用。 */
  pending: Set<string>;
  step: number;
  faultsInjected: number;
  events: Obj[];
  /** call_id → 该调用期望关联的 nonce,用于检出串线。 */
  callNonce: Map<string, string>;
  mismatches: string[];
}

const runs = new Map<Scenario, RunState>();
const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
app.get('/probe/report', async () => buildReport());

function nonceFor(scenario: string, tag: string): string {
  return `NONCE_${scenario.toUpperCase().replace(/-/g, '_')}_${tag}`;
}

/**
 * nonce 必须按**完整 token** 匹配。裸 `includes` 会让 `NONCE_X_a` 命中
 * `NONCE_X_a_SECOND`,followup 的第二个任务于是永远记不上账——这是探针自己的假阴性,
 * 曾误报成产品 bug。
 */
function hasNonce(text: string, nonce: string): boolean {
  return new RegExp(`${nonce}(?![A-Za-z0-9_])`).test(text);
}

/** 信封里的 `encrypted_content` 正文(NEW_TASK / MESSAGE 都走它)。 */
function encryptedBodyOf(parts: Obj[]): string | undefined {
  const part = parts.find((p: Obj) => typeof p?.encrypted_content === 'string');
  return part?.encrypted_content;
}

/** 子线程的任务正文(NEW_TASK 信封的 encrypted_content),没有则不是子线程请求。 */
function newTaskBody(body: Obj): string | undefined {
  const items = Array.isArray(body.input) ? body.input : [];
  let found: string | undefined;
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') continue;
    const parts = Array.isArray(item.content) ? item.content : [];
    const isNewTask = parts.some(
      (p: Obj) => typeof p?.text === 'string' && p.text.includes('NEW_TASK'),
    );
    const taskBody = encryptedBodyOf(parts);
    // 最后一条为准:followup 会在同一线程里再追加一条信封。
    if (isNewTask && taskBody !== undefined) found = taskBody;
  }
  return found;
}

/** 客户端回传的工具结果。 */
function callOutputs(body: Obj): { call_id: string; output: string }[] {
  const out: { call_id: string; output: string }[] = [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item && typeof item === 'object' && String(item.type).includes('call_output')) {
      out.push({
        call_id: String(item.call_id),
        output: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
      });
    }
  }
  return out;
}

function spawnFrame(state: RunState, tag: string, forkTurns?: string): Buffer {
  const taskName = `${state.scenario}_${tag}`.replace(/[^a-z0-9_]/gi, '_');
  const nonce = nonceFor(state.scenario, tag);
  state.agents.set(nonce, { taskName, nonce, deliveries: 0, observedByParent: 0, answeredBy: [] });
  const callId = `call_${taskName}_spawn_${state.step}`;
  state.callNonce.set(callId, nonce);
  state.pending.add(callId);
  return buildToolUseFrame(
    'spawn_agent',
    callId,
    JSON.stringify({
      task_name: taskName,
      ...(forkTurns ? { fork_turns: forkTurns } : {}),
      // 子线程必须原样回这个 nonce,父线程据此确认结果没有串线。
      message: `Reply with exactly this token and nothing else: ${nonce}`,
    }),
    true,
  );
}

function toolFrame(state: RunState, name: string, args: Obj, tag = name): Buffer {
  const callId = `call_${state.scenario}_${tag}_${state.step}`;
  state.pending.add(callId);
  if (typeof args.target === 'string') {
    const agent = [...state.agents.values()].find((a) => args.target.includes(a.taskName));
    if (agent) state.callNonce.set(callId, agent.nonce);
  }
  return buildToolUseFrame(name, callId, JSON.stringify(args), true);
}

function textFrame(text: string): Buffer {
  return buildAssistantResponseFrame(text);
}

/** 父线程剧本。每个 scenario 按「已完成的步骤数」推进,不看请求计数。 */
function parentFrames(state: RunState): Buffer[] {
  state.step += 1;
  const s = state.step;
  const agents = [...state.agents.values()];
  const target = (tag: string) => `/root/${state.scenario}_${tag}`.replace(/[^a-z0-9_/]/gi, '_');

  switch (state.scenario) {
    case 'single':
      if (s === 1) return [spawnFrame(state, 'a')];
      if (s === 2) return [toolFrame(state, 'wait_agent', {})];
      return [textFrame(`PARENT_DONE ${agents.map((a) => a.nonce).join(' ')}`)];

    case 'concurrent':
      // 两个 spawn 在**同一个响应**里发出 → 客户端并行创建,最考验不串线。
      if (s === 1) return [spawnFrame(state, 'a'), spawnFrame(state, 'b')];
      if (s === 2) return [toolFrame(state, 'wait_agent', {}, 'wait1')];
      if (s === 3) return [toolFrame(state, 'wait_agent', {}, 'wait2')];
      return [textFrame('PARENT_DONE')];

    case 'followup':
      if (s === 1) return [spawnFrame(state, 'a')];
      if (s === 2) return [toolFrame(state, 'wait_agent', {})];
      if (s === 3) {
        // 第二个任务复用同一个子 agent:nonce 换新,必须重新送达。
        const agent = agents[0];
        const second = `${agent?.nonce ?? 'NONCE'}_SECOND`;
        // 新增一条 nonce 记录(不改旧的):两个任务应各自送达一次、各自被回收一次。
        if (agent) {
          state.agents.set(second, {
            taskName: agent.taskName,
            nonce: second,
            deliveries: 0,
            observedByParent: 0,
            answeredBy: [],
          });
        }
        return [
          toolFrame(state, 'followup_task', {
            target: target('a'),
            message: `Reply with exactly this token and nothing else: ${second}`,
          }),
        ];
      }
      if (s === 4) return [toolFrame(state, 'wait_agent', {}, 'wait2')];
      return [textFrame('PARENT_DONE')];

    case 'interrupt':
      if (s === 1) return [spawnFrame(state, 'a')];
      if (s === 2) return [toolFrame(state, 'interrupt_agent', { target: target('a') })];
      if (s === 3) return [toolFrame(state, 'list_agents', {})];
      return [textFrame('PARENT_DONE')];

    case 'timeout':
      if (s === 1) return [spawnFrame(state, 'a')];
      // 极短 timeout:超时**不得**谎报完成,随后的 wait 仍应能取到最终结果。
      if (s === 2) return [toolFrame(state, 'wait_agent', { timeout_ms: 1 }, 'wait_short')];
      if (s === 3) return [toolFrame(state, 'wait_agent', { timeout_ms: 60000 }, 'wait_long')];
      return [textFrame('PARENT_DONE')];

    case 'fork-turns':
      if (s === 1) return [spawnFrame(state, 'none', 'none')];
      if (s === 2) return [toolFrame(state, 'wait_agent', {}, 'wait1')];
      if (s === 3) return [spawnFrame(state, 'all', 'all')];
      if (s === 4) return [toolFrame(state, 'wait_agent', {}, 'wait2')];
      return [textFrame('PARENT_DONE')];

    case 'fault-retry':
      if (s === 1) return [spawnFrame(state, 'a')];
      if (s === 2) return [toolFrame(state, 'wait_agent', {})];
      return [textFrame(`PARENT_DONE ${agents.map((a) => a.nonce).join(' ')}`)];

    case 'message':
      if (s === 1) return [spawnFrame(state, 'a')];
      // `wait_agent` 在子线程的**第一个**事件上返回,send_message 就是一个:第一次 wait 被它
      // 唤醒(实测「Wait completed.」先于 FINAL_ANSWER 回来),中间消息随父线程下一次请求送到。
      // 收到中间消息的父 agent 本来就该再 wait 一次拿最终答案——这是协议,不是补时序;
      // 只 wait 一次时 FINAL_ANSWER 赶不赶得上最后一轮纯看时序(本机赶上、Docker 没赶上)。
      if (s === 2) return [toolFrame(state, 'wait_agent', {}, 'wait1')];
      if (s === 3) return [toolFrame(state, 'wait_agent', {}, 'wait2')];
      return [textFrame(`PARENT_DONE ${agents.map((a) => a.nonce).join(' ')}`)];
  }
}

function buildReport(): Obj {
  const out: Obj = {};
  for (const [scenario, state] of runs) {
    const agents = [...state.agents.values()];
    out[scenario] = {
      requests: state.requests,
      steps: state.step,
      faultsInjected: state.faultsInjected,
      agents: agents.map((a) => ({ ...a })),
      // 每个 nonce 恰好送达一次 = 没有因重试重复创建/重复投递子任务。
      duplicateDeliveries: agents.filter((a) => a.deliveries > 1).map((a) => a.nonce),
      // interrupt 的**目的**就是让子任务来不及跑完:那里 undelivered/unobserved 属正常,
      // 该场景的判据是「不串线 + 客户端状态正常」,不是「任务必须送达」。
      undelivered:
        scenario === 'interrupt'
          ? []
          : agents.filter((a) => a.deliveries === 0).map((a) => a.nonce),
      unobservedByParent:
        scenario === 'interrupt'
          ? []
          : agents.filter((a) => a.observedByParent === 0).map((a) => a.nonce),
      mismatches: state.mismatches,
      // 判读看 lostAtGateway(>0 同时进 mismatches)与 reachedUpstream(>0 = 到了父线程模型)。
      ...(state.intermediate ? { intermediate: { ...state.intermediate } } : {}),
      events: state.events,
    };
  }
  return out;
}

for (const scenario of SCENARIOS) {
  const state: RunState = {
    scenario,
    requests: 0,
    agents: new Map(),
    pending: new Set(),
    step: 0,
    faultsInjected: 0,
    events: [],
    callNonce: new Map(),
    mismatches: [],
    intermediate:
      scenario === 'message'
        ? {
            nonce: 'INTERMEDIATE_NONCE_MESSAGE_7F3A',
            sendCallId: 'call_message_a_send_1',
            sentBySub: 0,
            envelopeSeenByParent: 0,
            envelopeBodyPresent: 0,
            reachedUpstream: 0,
            lostAtGateway: 0,
          }
        : undefined,
  };
  runs.set(scenario, state);

  await app.register(
    async (instance) => {
      /** 本次请求要发什么:在 preHandler 里定好,provider 只负责吐出去。 */
      let nextFrames: Buffer[] = [];
      let injectFault = false;
      /** 本次请求是不是子线程(provider 侧据此决定要不要查中间 nonce)。 */
      let isSubThread = false;
      /** 本次父线程请求的入口是否带着中间消息正文。 */
      let messageBodyAtInput = false;

      instance.addHook('preHandler', async (request) => {
        const body = request.body as Obj;
        if (!body || typeof body !== 'object') return;
        state.requests += 1;
        isSubThread = false;
        messageBodyAtInput = false;
        // 每个请求的 input item 类型序列:排查「客户端到底送没送某类 item」时用。
        state.events.push({
          n: state.requests,
          input_types: (Array.isArray(body.input) ? body.input : []).map((i: Obj) =>
            String(i?.type ?? i?.role ?? '?'),
          ),
        });

        // 记录**所有**线程间信封的形状:NEW_TASK 之外还有哪几类、各自怎么承载正文。
        for (const item of Array.isArray(body.input) ? body.input : []) {
          if (!item || typeof item !== 'object' || item.type !== 'agent_message') continue;
          const parts = Array.isArray(item.content) ? item.content : [];
          const head = parts.find((p: Obj) => typeof p?.text === 'string')?.text ?? '';
          state.events.push({
            n: state.requests,
            envelope: {
              author: item.author,
              recipient: item.recipient,
              partTypes: parts.map((p: Obj) => p?.type),
              head: String(head).slice(0, 100),
            },
          });
          const im = state.intermediate;
          if (im && hasNonce(String(head), 'Message Type: MESSAGE')) {
            im.envelopeSeenByParent += 1;
            const msgBody = encryptedBodyOf(parts);
            if (msgBody !== undefined && hasNonce(msgBody, im.nonce)) {
              im.envelopeBodyPresent += 1;
              messageBodyAtInput = true;
            }
          }
          // 子 agent 的答案走 FINAL_ANSWER 信封回父线程(wait_agent 的工具结果里没有它)。
          // author 就是交活的那个线程 → 用它检串线,比 call_id 更直接。
          const author = String(item.author ?? '');
          if (author && author !== '/root') {
            for (const rec of state.agents.values()) {
              if (!hasNonce(String(head), rec.nonce)) continue;
              rec.observedByParent += 1;
              rec.answeredBy.push(author);
              if (!author.endsWith(rec.taskName)) {
                state.mismatches.push(
                  `${rec.nonce} answered by ${author}, expected ${rec.taskName}`,
                );
              }
            }
          }
        }

        const taskBody = newTaskBody(body);
        if (taskBody) {
          // —— 子线程 ——
          isSubThread = true;
          injectFault = false;
          const agent = [...state.agents.values()].find((a) => hasNonce(taskBody, a.nonce));
          const token = agent?.nonce ?? 'NONCE_UNKNOWN';
          const im = state.intermediate;
          // message 场景的第二轮:send_message 的回执已回来 → 只交最终答案,不再算一次送达。
          const receipt = im && callOutputs(body).find((c) => c.call_id === im.sendCallId);
          if (receipt) {
            state.events.push({
              n: state.requests,
              thread: 'sub',
              send_message_receipt: receipt.output.slice(0, 160),
            });
          } else {
            if (agent) agent.deliveries += 1;
            else
              state.mismatches.push(
                `sub-thread task body carries no known nonce: ${state.requests}`,
              );
            if (im) im.sentBySub += 1;
            state.events.push({
              n: state.requests,
              thread: 'sub',
              nonce: token,
              ...(im ? { send_message: 1 } : {}),
            });
          }
          // message 场景第一轮先给父线程发中间消息(target 用父线程的规范名 `/root`),其余原样回 nonce。
          nextFrames =
            im && !receipt
              ? [
                  buildToolUseFrame(
                    'send_message',
                    im.sendCallId,
                    JSON.stringify({
                      target: '/root',
                      message: `Intermediate note for the parent: ${im.nonce}`,
                    }),
                    true,
                  ),
                ]
              : [textFrame(token)];
          return;
        }

        // —— 父线程 ——
        for (const { call_id, output } of callOutputs(body)) {
          if (!state.pending.delete(call_id)) continue;
          const expected = state.callNonce.get(call_id);
          for (const agent of state.agents.values()) {
            if (hasNonce(output, agent.nonce)) {
              agent.observedByParent += 1;
              // 串线检测:这个 call_id 关联的 nonce 与结果里出现的必须一致。
              if (expected && expected !== agent.nonce) {
                state.mismatches.push(`${call_id} expected ${expected} but saw ${agent.nonce}`);
              }
            }
          }
          state.events.push({
            n: state.requests,
            thread: 'parent',
            call_id,
            output: output.slice(0, 120),
          });
        }

        // fault-retry:第 2 次父线程请求注入一次 503。客户端重试后**不得**重新 spawn。
        injectFault = scenario === 'fault-retry' && state.step === 1 && state.faultsInjected === 0;
        if (injectFault) {
          state.faultsInjected += 1;
          state.events.push({ n: state.requests, thread: 'parent', injected: 'transient-503' });
          return;
        }
        nextFrames = parentFrames(state);
      });

      /**
       * 决定性对照:父线程转换后的**上游请求**里有没有中间 nonce。只查父线程——子线程
       * 自己的历史里带着 send_message 的 arguments,天然含 nonce,查它是假阳性。
       * 只记计数,不记正文(日志红线)。
       */
      const recordIntermediateDelivery = (requestBody: string): void => {
        const im = state.intermediate;
        if (!im || isSubThread) return;
        const upstreamHasBody = hasNonce(requestBody, im.nonce);
        if (upstreamHasBody) im.reachedUpstream += 1;
        if (messageBodyAtInput && !upstreamHasBody) {
          im.lostAtGateway += 1;
          state.mismatches.push(`intermediate MESSAGE body dropped by gateway: ${state.requests}`);
        }
        state.events.push({
          n: state.requests,
          thread: 'parent',
          message_body_at_input: messageBodyAtInput,
          message_body_at_upstream: upstreamHasBody,
        });
      };

      // 每条剧本回复都是「正常完成」(本探针没有截断场景),尾帧统一由 completedFrames 补。
      const provider = {
        async callApiStream(requestBody: string) {
          if (injectFault) throw new ProviderError({ kind: 'transient', status: 503 }, 'injected');
          recordIntermediateDelivery(requestBody);
          const frames = completedFrames(...nextFrames);
          const data = (async function* () {
            yield* frames;
          })();
          return { data, status: 200, headers: {} } as AxiosResponse;
        },
        async callApi(requestBody: string) {
          if (injectFault) throw new ProviderError({ kind: 'transient', status: 503 }, 'injected');
          recordIntermediateDelivery(requestBody);
          return {
            data: Buffer.concat(completedFrames(...nextFrames)),
            status: 200,
            headers: {},
          } as AxiosResponse;
        },
      } as unknown as KiroProvider;

      await registerOpenAiRoutes(instance, {
        apiKey: 'lifecycle-probe-key',
        kiroProvider: provider,
        extractThinking: true,
        identityOverride: false,
        rejectUnsupportedDocuments: true,
        toolDescriptionMaxLen: 32768,
        abortUpstreamOnDisconnect: false,
        emptyStreamRetries: 0,
        toolCallTextRescue: false,
        hookBus: new HookBus(),
      });
    },
    { prefix: `/case/${scenario}/openai/v1` },
  );
}

const address = await app.listen({
  port: Number(process.env.K2C_LIFECYCLE_PORT ?? 18962),
  host: '0.0.0.0',
});
console.log(`CODEX_SUBAGENT_LIFECYCLE_READY ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    const report = buildReport();
    await writeFile(resolve(reportDir, 'lifecycle.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  });
}
