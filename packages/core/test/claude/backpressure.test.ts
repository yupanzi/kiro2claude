/**
 * Backpressure tests: `write()` returning `false` is flow control, NOT a disconnect.
 *
 * `stream.write()` returns `false` when the socket's internal buffer is above
 * highWaterMark — "wait for 'drain' before writing more". The socket is healthy.
 * The historical `safeWrite` returned that value straight through, so every
 * caller read "buffer full" as "client disconnected": the read loop stopped
 * forwarding to a live client, the terminal path dropped `message_stop`, the
 * upstream was still drained to EOF (full billing), and the log blamed the client.
 *
 * Because only a *large number of bytes* fills that buffer, the misread bit
 * exactly the longest and most expensive responses. In production the
 * misclassified streams had an order of magnitude more `output_tokens` than real
 * disconnects and not one was shorter than two minutes, while real disconnects
 * had a median duration of ~3s — byte-driven vs time-driven, which is what ruled
 * out "the user pressed Ctrl-C".
 *
 * Guarded here from both sides: backpressure must NOT be read as a disconnect,
 * and a genuine dead socket must STILL be read as one.
 */

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AxiosResponse } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { awaitDrain, safeWrite } from '../../src/claude/stream.js';
import { handleStreamRequest } from '../../src/claude/stream-handler.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { logger } from '../../src/shared/logger.js';
import { buildAssistantResponseFrame, buildMeteringFrame } from '../helpers/event-stream.js';

const MODEL = 'claude-opus-4-6';

/**
 * Socket double. `writeReturns=false` models backpressure (healthy socket, full
 * buffer); `throwAfter` models a genuinely dead socket (EPIPE on write).
 */
class FakeSocket extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  writeReturns = true;
  throwAfter = Number.POSITIVE_INFINITY;
  writeHead = vi.fn();

  write(chunk: string): boolean {
    if (this.writes.length >= this.throwAfter) {
      const e = new Error('write EPIPE') as Error & { code?: string };
      e.code = 'EPIPE';
      throw e;
    }
    this.writes.push(chunk);
    return this.writeReturns;
  }

  end(): void {
    this.writableEnded = true;
  }

  get body(): string {
    return this.writes.join('');
  }
}

function providerYielding(frames: Buffer[]): KiroProvider {
  const upstream = new Readable({ read() {} });
  for (const f of frames) upstream.push(f);
  upstream.push(null);
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

const CONTENT_FRAMES = [
  buildAssistantResponseFrame('hello '),
  buildAssistantResponseFrame('world'),
  buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.2 }),
];

describe('safeWrite: flow control is not liveness', () => {
  it('returns true when write() reports backpressure (socket healthy)', () => {
    const s = new FakeSocket();
    s.writeReturns = false; // 背压
    expect(safeWrite(s as never, 'x')).toBe(true);
    expect(s.writes).toEqual(['x']);
  });

  it('returns false when the socket is destroyed', () => {
    const s = new FakeSocket();
    s.destroyed = true;
    expect(safeWrite(s as never, 'x')).toBe(false);
    expect(s.writes).toEqual([]); // 不该再往死 socket 写
  });

  it('returns false when the socket is already ended', () => {
    const s = new FakeSocket();
    s.writableEnded = true;
    expect(safeWrite(s as never, 'x')).toBe(false);
  });

  it('returns false when write() throws (EPIPE)', () => {
    const s = new FakeSocket();
    s.throwAfter = 0;
    expect(safeWrite(s as never, 'x')).toBe(false);
  });
});

describe('awaitDrain', () => {
  it('is a no-op when the buffer is not above highWaterMark', async () => {
    const s = new FakeSocket(); // writableNeedDrain=false
    await expect(awaitDrain(s as never)).resolves.toBeUndefined();
  });

  it("resolves on 'drain'", async () => {
    const s = new FakeSocket();
    s.writableNeedDrain = true;
    const p = awaitDrain(s as never);
    s.emit('drain');
    await expect(p).resolves.toBeUndefined();
    // 监听器必须摘干净,否则长流上会堆积
    expect(s.listenerCount('drain')).toBe(0);
    expect(s.listenerCount('close')).toBe(0);
    expect(s.listenerCount('error')).toBe(0);
  });

  it("resolves on 'close' so a vanished client cannot hang the read loop", async () => {
    const s = new FakeSocket();
    s.writableNeedDrain = true;
    const p = awaitDrain(s as never);
    s.emit('close');
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves on timeout so a client that never reads cannot stall the upstream', async () => {
    vi.useFakeTimers();
    try {
      const s = new FakeSocket();
      s.writableNeedDrain = true;
      const p = awaitDrain(s as never);
      // 既不 drain 也不 close —— 只有超时能救场。
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(p).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stream handler under backpressure', () => {
  it('delivers the FULL response (incl. message_stop) when write() returns false', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    try {
      const socket = new FakeSocket();
      socket.writeReturns = false; // 每次 write 都报背压,但 socket 一直健康
      await handleStreamRequest(
        providerYielding(CONTENT_FRAMES),
        '{}',
        MODEL,
        10,
        false,
        new Map(),
        new HookBus(),
        { raw: socket } as never,
        0,
      );

      // ★ 核心断言:响应必须完整收尾。修复前 aborted 被置位 → 终结事件全丢。
      expect(socket.body).toContain('event: message_start');
      expect(socket.body).toContain('hello ');
      expect(socket.body).toContain('world');
      expect(socket.body).toContain('event: message_stop');

      // 而且不得把这当成客户端断连上报 —— 否则运维会去查一个不存在的客户端问题。
      const msgs = infoSpy.mock.calls.map((a) =>
        a[0] && typeof a[0] === 'object' && 'msg' in a[0] ? String(a[0].msg) : '',
      );
      expect(msgs).not.toContain('sse client disconnected');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('still stops forwarding when the socket genuinely dies mid-stream', async () => {
    // 反向守卫:上面的修复只放过背压。write 真的抛错(EPIPE)时必须仍判断连,
    // 否则这次改动会把真故障一起吞掉。
    const socket = new FakeSocket();
    socket.throwAfter = 1; // 第 1 次写成功(commit 冲刷),之后全抛
    await handleStreamRequest(
      providerYielding(CONTENT_FRAMES),
      '{}',
      MODEL,
      10,
      false,
      new Map(),
      new HookBus(),
      { raw: socket } as never,
      0,
    );
    expect(socket.writes.length).toBe(1);
    expect(socket.body).not.toContain('event: message_stop');
  });
});
