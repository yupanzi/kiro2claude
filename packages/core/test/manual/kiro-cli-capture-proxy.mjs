#!/usr/bin/env node
/**
 * kiro-cli 转发型录制代理(手工探针,不进 CI,💰 打真实上游)。
 *
 * 与 `scripts/capture-kiro-cli.sh`(mock 上游、只抓请求形态)和 `kiro-cli-probe.ts`
 * (伪造 event-stream 驱动行为)互补:这个把 kiro-cli 的请求**原样转发到真实上游**,
 * 同时把请求 + 响应(原始字节 + 解码后的 event 帧)落盘。用途是看**真实上游怎么回**
 * (reasoningContentEvent 的 text / signature / redactedContent 形态、尾帧、metering),
 * 以及 kiro-cli **下一轮**怎么把上一轮的 reasoning 回传(history 里的 `reasoningContent`)。
 *
 * 单端口,按 `x-amz-target` 前缀路由到三个真实 host,所以 V2(Rust 引擎)的三个
 * endpoint setting 与 V3(KAS 子进程)的 `KIRO_KAS_ENDPOINT` 都指到同一个端口即可。
 *
 * ## 用法
 *
 * ```bash
 * CAP_DIR=/tmp/kiro-cap node packages/core/test/manual/kiro-cli-capture-proxy.mjs &
 *
 * # V2(默认引擎):三个 key 都指过来
 * for k in api.codewhisperer.service api.krs.service api.cps.service; do
 *   kiro-cli settings "$k" '{"endpoint":"http://127.0.0.1:18446","region":"us-east-1"}'
 * done
 * kiro-cli chat --no-interactive --trust-tools= --model claude-opus-5 --effort max "..."
 * kiro-cli chat --no-interactive --trust-tools= --resume "..."      # 第二轮看 history
 *
 * # V3(KAS):子进程自己有 HTTP 客户端,靠 env 覆盖
 * KIRO_KAS_ENDPOINT=http://127.0.0.1:18446 KIRO_KAS_CONTROL_PLANE_ENDPOINT=http://127.0.0.1:18446 \
 *   kiro-cli chat --v3 --no-interactive --trust-tools= --model claude-opus-5 --effort max "..."
 *
 * # ★ 必须还原
 * for k in api.codewhisperer.service api.krs.service api.cps.service; do kiro-cli settings --delete "$k"; done
 * ```
 *
 * 落盘:`$CAP_DIR/NNN-<target>.json`(请求头脱敏 + 请求体 + 响应头 + 解码帧)与
 * `NNN.res.bin`(响应原始字节)。`authorization` 不落盘;profileArn 替换成零账号占位符。
 * 脱敏比 `scripts/capture-kiro-cli.sh` 窄(不抹 cwd / clientId / conversationId 等):产物只供
 * 本机看,要贴进 issue 或文档前先按 CONTRIBUTING「脱敏」过一遍。
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const DIR = process.env.CAP_DIR ?? '/tmp/kiro-cap';
const PORT = Number(process.env.CAP_PORT ?? 18446);
const REGION = process.env.CAP_REGION ?? 'us-east-1';
const HOSTS = {
  runtime: `runtime.${REGION}.kiro.dev`,
  codewhisperer: REGION === 'us-east-1' ? `codewhisperer.${REGION}.amazonaws.com` : `q.${REGION}.amazonaws.com`,
  management: `management.${REGION}.kiro.dev`,
};
const REDACTED_ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/REDACTED';

fs.mkdirSync(DIR, { recursive: true });
let seq = 0;

function pickHost(target, urlPath) {
  const t = String(target ?? '');
  if (t.startsWith('AmazonCodeWhispererService.')) return HOSTS.codewhisperer;
  if (t.startsWith('KiroControlPlane')) return HOSTS.management;
  if (t.startsWith('AmazonCodeWhispererStreamingService.') || t.startsWith('KiroRuntimeService.')) return HOSTS.runtime;
  // 无 target:按路径猜。KAS / cps 的 REST 风格路径落这里。
  if (/^\/(generateAssistantResponse|mcp|v1\/)/.test(urlPath)) return HOSTS.runtime;
  if (/profile|management|workspace|feature/i.test(urlPath)) return HOSTS.management;
  return HOSTS.runtime;
}

function redact(s) {
  return String(s).replace(/arn:aws:codewhisperer:[^"'\s&]+/g, REDACTED_ARN);
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'authorization' || k === 'host') continue;
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}

/** 最小 AWS event-stream 解码:只为落盘可读,不校验 CRC。 */
function decodeEventStream(buf) {
  const frames = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const total = buf.readUInt32BE(off);
    const hlen = buf.readUInt32BE(off + 4);
    if (total < 16 || off + total > buf.length) break;
    const headers = {};
    let p = off + 12;
    const hend = p + hlen;
    while (p < hend) {
      const nlen = buf[p];
      p += 1;
      const name = buf.subarray(p, p + nlen).toString('utf8');
      p += nlen;
      const type = buf[p];
      p += 1;
      let value;
      switch (type) {
        case 0:
        case 1:
          value = type === 0;
          break;
        case 2:
          value = buf.readInt8(p);
          p += 1;
          break;
        case 3:
          value = buf.readInt16BE(p);
          p += 2;
          break;
        case 4:
          value = buf.readInt32BE(p);
          p += 4;
          break;
        case 5:
          value = buf.readBigInt64BE(p).toString();
          p += 8;
          break;
        case 6:
        case 7: {
          const l = buf.readUInt16BE(p);
          p += 2;
          value = type === 7 ? buf.subarray(p, p + l).toString('utf8') : buf.subarray(p, p + l).toString('base64');
          p += l;
          break;
        }
        case 8:
          value = buf.readBigInt64BE(p).toString();
          p += 8;
          break;
        case 9:
          value = buf.subarray(p, p + 16).toString('hex');
          p += 16;
          break;
        default:
          value = `<type ${type}>`;
          p = hend;
      }
      headers[name] = value;
    }
    const payload = buf.subarray(hend, off + total - 4);
    let body;
    try {
      body = JSON.parse(payload.toString('utf8'));
    } catch {
      body = payload.toString('utf8');
    }
    frames.push({ headers, payload: body });
    off += total;
  }
  return { frames, trailingBytes: buf.length - off };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks);
    const target = req.headers['x-amz-target'];
    const host = pickHost(target, req.url.split('?')[0]);
    const n = ++seq;
    const tag = String(target ?? req.url.split('?')[0].replace(/\//g, '_')).replace(/[^A-Za-z0-9._-]/g, '_');
    const base = path.join(DIR, `${String(n).padStart(3, '0')}-${tag}`);
    const startedAt = Date.now();
    const record = {
      seq: n,
      startedAt: new Date(startedAt).toISOString(),
      upstreamHost: host,
      method: req.method,
      url: redact(req.url),
      requestHeaders: redactHeaders(req.headers),
      requestBody: (() => {
        const t = reqBody.toString('utf8');
        try {
          return JSON.parse(redact(t));
        } catch {
          return redact(t);
        }
      })(),
      requestBodyLength: reqBody.length,
    };
    process.stderr.write(`→ #${n} ${req.method} ${req.url.split('?')[0]} ${target ?? ''} → ${host} (${reqBody.length}B)\n`);

    const fwdHeaders = { ...req.headers, host };
    delete fwdHeaders['accept-encoding']; // 要明文 event-stream 落盘,不要 gzip
    fwdHeaders['content-length'] = String(reqBody.length);

    const up = https.request(
      { host, method: req.method, path: req.url, headers: fwdHeaders },
      (upRes) => {
        const resChunks = [];
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on('data', (c) => {
          resChunks.push(c);
          res.write(c);
        });
        upRes.on('end', () => {
          res.end();
          const resBody = Buffer.concat(resChunks);
          record.response = {
            status: upRes.statusCode,
            headers: upRes.headers,
            durationMs: Date.now() - startedAt,
            bodyLength: resBody.length,
          };
          const ct = String(upRes.headers['content-type'] ?? '');
          if (ct.includes('vnd.amazon.eventstream')) {
            record.response.eventStream = decodeEventStream(resBody);
          } else {
            const t = resBody.toString('utf8');
            try {
              record.response.body = JSON.parse(redact(t));
            } catch {
              record.response.body = redact(t);
            }
          }
          fs.writeFileSync(`${base}.res.bin`, resBody);
          fs.writeFileSync(`${base}.json`, JSON.stringify(record, null, 2));
          process.stderr.write(`← #${n} ${upRes.statusCode} ${resBody.length}B ${record.response.durationMs}ms\n`);
        });
      },
    );
    up.on('error', (err) => {
      process.stderr.write(`✗ #${n} upstream error: ${err.message}\n`);
      record.response = { error: err.message };
      fs.writeFileSync(`${base}.json`, JSON.stringify(record, null, 2));
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ __type: 'ProxyError', message: err.message }));
    });
    up.end(reqBody);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`capture proxy listening on http://127.0.0.1:${PORT} → ${JSON.stringify(HOSTS)}; dir=${DIR}\n`);
  process.stdout.write('LISTEN\n');
});
