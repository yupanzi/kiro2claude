/**
 * 请求级上下文传播。
 *
 * 利用 Node.js AsyncLocalStorage 在整个异步调用链中自动传递请求 ID
 * 和起始时间，无需修改任何函数签名。Fastify onRequest hook 负责初始化
 * 上下文，后续所有 await 边界（包括流处理）都能通过 getRequestContext()
 * 拿到当前请求的元数据。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

export interface RequestContext {
  /** 8 字符 hex 请求关联 ID */
  reqId: string;
  /** 请求到达时刻 (Date.now()) */
  startTime: number;
}

export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** 获取当前请求上下文；启动代码 / 测试中返回 undefined */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/** 生成 8 字符 hex 请求 ID（4 字节随机数） */
export function generateReqId(): string {
  return crypto.randomBytes(4).toString('hex');
}
