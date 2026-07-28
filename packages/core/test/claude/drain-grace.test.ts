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
import { buildAssistantResponseFrame } from '../helpers/event-stream.js';

const MODEL = 'claude-sonnet-4-5-20250929';
/** 与 stream-handler.ts 的 POST_DISCONNECT_DRAIN_IDLE_MS 对齐。 */
const DRAIN_IDLE_MS = 15_000;

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

      const provider = {
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

      const done = handleStreamRequest(
        provider,
        '{}',
        MODEL,
        10,
        false,
        new Map(),
        new HookBus(),
        reply,
        0,
      );

      // 让 handler 真正进到 for-await(draining=true)并消费掉那一帧,
      // 否则 armDrainGrace 的 `!draining` 守卫会直接 return,宽限窗根本不武装。
      await vi.advanceTimersByTimeAsync(0);

      // 客户端断连 → 进入 drain 宽限窗。
      closeCb?.();
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

      const provider = {
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

      const reply = {
        raw: {
          writeHead: vi.fn(),
          write: vi.fn(() => true),
          end: vi.fn(),
          on: vi.fn(),
        },
      } as never;

      await handleStreamRequest(
        provider,
        '{}',
        MODEL,
        10,
        false,
        new Map(),
        new HookBus(),
        reply,
        0,
      );

      expect(collectMsgs(errorSpy)).toContain('error reading response stream');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
