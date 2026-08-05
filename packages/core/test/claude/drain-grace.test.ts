/**
 * Post-disconnect drain-grace tests.
 *
 * 当客户端断连而上游仍挂着时,handler 会给上游一个 idle 宽限窗
 * (`POST_DISCONNECT_DRAIN_IDLE_MS` = 15s)去吐完尾帧(Metering);超时未动静就
 * **主动 destroy** 上游 socket,免得一个没人读的流占满连接池。
 *
 * 这里钉住的是那次 destroy 的**善后**:socket 被我们自己销毁后,读流循环必然
 * 抛 `ERR_STREAM_PREMATURE_CLOSE`。那是我们那一行 `destroy()` 的直接结果,不是
 * 上游故障 —— 不能记成 error。
 *
 * 回归背景:修复前每次 drain-grace 到期都配一条 level-50 的
 * `error reading response stream: ERR_STREAM_PREMATURE_CLOSE`,生产日志里 warn 与
 * error 计数严格 1:1 —— 100% 由网关自己制造,却在运维视角上表现为「上游在报错」。
 */

import { Readable } from 'node:stream';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { handleStreamRequest } from '../../src/claude/stream-handler.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { logger } from '../../src/shared/logger.js';
import { buildAssistantResponseFrame, framesWithMetering } from '../helpers/event-stream.js';

const MODEL = 'claude-sonnet-4-5-20250929';
/** 与 stream-handler.ts 的 POST_DISCONNECT_DRAIN_IDLE_MS 对齐。 */
const DRAIN_IDLE_MS = 15_000;

// —— spy 读取:两个投影,msg-only 与全字段。本仓库两种 pino 调用形态并存
// (`warn('str')` 与 `warn({msg,...})`),collectMsgs 必须容忍前者,collectFields
// 只对后者有意义 —— 放一起,免得日后有人只改其一。

/** 收集某个 pino level 上所有调用的 `msg` 字段。 */
function collectMsgs(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => {
    const first = args[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'msg' in first) {
      return String((first as { msg: unknown }).msg);
    }
    return '';
  });
}

/** 收集某个 pino level 上所有**对象形态**调用的完整字段(不止 msg)。 */
function collectFields(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((args) => args[0])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object');
}

/** 只吐 `upstream` 这一条流的 provider 替身。 */
function stubProvider(upstream: Readable): KiroProvider {
  return {
    callApiStream: vi.fn(
      async () =>
        ({
          data: upstream,
          status: 200,
          statusText: 'OK',
          headers: {},
          config: {} as AxiosResponse['config'],
        }) as AxiosResponse,
    ),
    callApi: vi.fn(),
    callMcp: vi.fn(),
  } as unknown as KiroProvider;
}

/**
 * reply 替身。始终捕获 `'close'`,由测试自行决定要不要 `close()` 触发断连——
 * 「断连」与「不断连」两类用例因此共用同一个替身,不必各写一份。
 */
function stubReply(): { reply: never; close: () => void } {
  let closeCb: (() => void) | undefined;
  const reply = {
    raw: {
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
      on: vi.fn((ev: string, cb: () => void) => {
        if (ev === 'close') closeCb = cb;
      }),
    },
  } as never;
  return { reply, close: () => closeCb?.() };
}

/** 固定住 handleStreamRequest 的 9 个位置参数,只留本文件真正会变的三个。 */
function runStream(provider: KiroProvider, bus: HookBus, reply: never): Promise<unknown> {
  return handleStreamRequest(provider, '{}', MODEL, 10, false, new Map(), bus, reply, 0);
}

/** 抓 usage-finish hook 上的计费 meta。 */
function captureUsageMeta(): {
  bus: HookBus;
  captured: Array<{ missing: unknown; credits: unknown }>;
} {
  const captured: Array<{ missing: unknown; credits: unknown }> = [];
  const bus = new HookBus();
  bus.registerUsageFinish('probe', (e) => {
    captured.push({
      missing: e.getMeta('kiro.meteringMissing'),
      credits: e.getMeta('kiro.creditsUsed'),
    });
  });
  return { bus, captured };
}

describe('post-disconnect drain grace: self-destroy is not an upstream error', () => {
  it('grace expiry destroys the socket and logs it at info, never at error', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      // 永不 EOF 的上游:推一帧内容后就静默挂着,正是 drain-grace 要处理的形状。
      const upstream = new Readable({ read() {} });
      upstream.push(buildAssistantResponseFrame('partial'));

      const { reply, close } = stubReply();
      const done = runStream(stubProvider(upstream), new HookBus(), reply);

      // 让 handler 真正进到 for-await(draining=true)并消费掉那一帧,
      // 否则 armDrainGrace 的 `!draining` 守卫会直接 return,宽限窗根本不武装。
      await vi.advanceTimersByTimeAsync(0);

      // 客户端断连 → 进入 drain 宽限窗。
      close();
      // 宽限窗到期 → handler 自己 destroy 上游 → 读流抛 ERR_STREAM_PREMATURE_CLOSE。
      await vi.advanceTimersByTimeAsync(DRAIN_IDLE_MS + 1);
      await done;

      // destroy 这一步本身仍要留痕(运维需要知道有流被主动回收)。
      expect(collectMsgs(warnSpy).some((m) => m.includes('drain grace expired'))).toBe(true);

      // ★ 核心断言:我们自己 destroy 引发的读流异常不得记为 error。
      const errorMsgs = collectMsgs(errorSpy);
      expect(errorMsgs).not.toContain('error reading response stream');

      // 而且它要以 info 显形,不能被整个吞掉 —— 否则排障时看不到流是怎么收场的。
      expect(collectMsgs(infoSpy).some((m) => m.includes('closed after drain grace expired'))).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('a genuine mid-stream read failure is still logged at error', async () => {
    // 反向守卫:上面的豁免只对「我们自己 destroy」生效。上游真的把连接摔了
    // (destroy 带 error、宽限窗从未武装)仍必须是 error —— 否则这个修复就把
    // 真故障一起静音了。
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    try {
      const upstream = new Readable({ read() {} });
      upstream.push(buildAssistantResponseFrame('partial'));
      // 客户端从未断连,宽限窗不参与;上游自行以错误终止。
      setImmediate(() => upstream.destroy(new Error('upstream exploded')));

      await runStream(stubProvider(upstream), new HookBus(), stubReply().reply);

      expect(collectMsgs(errorSpy)).toContain('error reading response stream');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/**
 * drain grace 到期丢掉尾帧 Metering 时的**账目**后果。
 *
 * credit 只在流末尾那一帧里。客户端断连后宽限窗到期、网关自己 destroy 了 socket,
 * 这一帧就永远收不到 —— 而上游那边内容早已生成、**照常扣费**。消费方
 * (plugin-metering)看到 `kiro.creditsUsed == null` 会整笔跳过,于是累计用量
 * 系统性偏低,且没有任何痕迹。
 *
 * 生产实测(2026-08-04,三台 fleet):`drained_after_disconnect=true` 的条数减去
 * 实际拿到 usage 的条数,精确等于 `drain grace expired` 的 warn 数 —— c1 差 0/
 * grace 0、c2 差 2/grace 2、c3 差 6/grace 6,三台全中。
 *
 * 这里钉的是:那笔漏账必须被**显式标记**(而不是伪装成一个普通的「本来就没有
 * credit」),让插件与运维都能把它和真·空流区分开。
 */
describe('post-disconnect drain grace: the dropped Metering frame is accounted for', () => {
  it('flags metering_lost / kiro.meteringMissing when grace expiry drops the tail Metering frame', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    try {
      // 上游吐了内容(= 已经产生计费)后就静默挂着,尾帧 Metering 永远不来。
      const upstream = new Readable({ read() {} });
      upstream.push(buildAssistantResponseFrame('partial'));

      const { bus, captured } = captureUsageMeta();
      const { reply, close } = stubReply();
      const done = runStream(stubProvider(upstream), bus, reply);

      await vi.advanceTimersByTimeAsync(0);
      close();
      await vi.advanceTimersByTimeAsync(DRAIN_IDLE_MS + 1);
      await done;

      // 计费 hook 照常跑(内容已产出),但拿不到 credit —— 插件据此整笔跳过。
      expect(captured).toHaveLength(1);
      expect(captured[0].credits).toBeUndefined();

      // ★ 核心断言:这笔漏账被显式标记,而不是表现为普通的「没有 credit」。
      expect(captured[0].missing).toBe(true);

      // 运维侧同样要能 grep 到,否则漏账规模无从统计。
      const withFlag = [...collectFields(infoSpy), ...collectFields(warnSpy)].filter(
        (f) => 'metering_lost' in f,
      );
      expect(withFlag.some((f) => f.metering_lost === true)).toBe(true);

      // 漏账是账目问题,不是上游故障:socket 是网关自己 destroy 的,善后异常
      // 不得升格成 error(与上一个 describe 同一条红线,这里顺带守住)。
      expect(collectMsgs(errorSpy)).not.toContain('error reading response stream');
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not flag a stream whose tail Metering frame arrived normally', async () => {
    // 反向守卫:正常收尾的流绝不能被标成漏账 —— 否则这个字段一文不值,运维
    // 按它统计出来的漏账规模会等于全部流量。
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const upstream = Readable.from(
        framesWithMetering({ unit: 'credit', unitPlural: 'credits', usage: 0.42 }),
      );

      const { bus, captured } = captureUsageMeta();
      await runStream(stubProvider(upstream), bus, stubReply().reply);

      expect(captured).toHaveLength(1);
      expect(captured[0].credits).toBe(0.42);
      expect(captured[0].missing).toBe(false);

      const withFlag = collectFields(infoSpy).filter((f) => 'metering_lost' in f);
      expect(withFlag.length).toBeGreaterThan(0);
      expect(withFlag.every((f) => f.metering_lost === false)).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });
});
