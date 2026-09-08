/**
 * kiro-cli 行为探针（手工实验用，不进 CI）。
 *
 * 把 kiro-cli 的三个 endpoint setting 指向本地明文端口后跑起来，它会：
 *   1. 记录所有入站请求（headers + body）到 `/tmp/kiro-probe/raw.json`
 *   2. 对 `GenerateAssistantResponse` 返回**伪造的 event-stream**，让 kiro-cli
 *      真的去调某个工具（`PROBE_TOOL` 指定）——这样才能抓到该工具**执行时**
 *      发出的 wire（web_search 走不走 InvokeMCP、图片怎么进 body 等）。
 *   3. `PROBE_STATUS` 非 200 时对 GAR 返回该状态码，用来观察 kiro-cli 自己的
 *      5xx/429 重试策略（次数、退避、哪些码重试）。
 *
 * 与 `scripts/capture-kiro-cli.sh` 互补：那个只抓**静态**请求形态（并据此生成
 * fixture），这个能驱动 kiro-cli **真的执行某个工具**、以及**注入错误状态码**，
 * 抓的是行为而非形态。手工跑，不进 CI（文件名不匹配 `*.test.ts`，vitest 不收）。
 *
 * ## 用法
 *
 * ```bash
 * # 1) 起探针（选一个要观察的工具）
 * cd packages/core
 * PROBE_TOOL=web_search PROBE_TOOL_INPUT='{"query":"x"}' npx tsx test/manual/kiro-cli-probe.ts &
 *
 * # 2) 把 kiro-cli 指过来（三个 endpoint 都要覆盖，理由见 capture-kiro-cli.sh 头注释）
 * for k in api.codewhisperer.service api.krs.service api.cps.service; do
 *   kiro-cli settings "$k" '{"endpoint":"http://127.0.0.1:18445","region":"us-east-1"}'
 * done
 *
 * # 3) 驱动
 * kiro-cli chat --no-interactive --trust-all-tools "搜索点什么"
 *
 * # 4) ★ 必须还原，否则 kiro-cli 会一直打本地端口
 * for k in api.codewhisperer.service api.krs.service api.cps.service; do
 *   kiro-cli settings --delete "$k"
 * done
 * ```
 *
 * 观察错误策略把第 1 步换成 `PROBE_STATUS=503`（或 `PROBE_STATUS=429
 * PROBE_RESP_HEADERS='{"retry-after":"7"}'`），然后数 `raw.json` 里 GAR 的
 * `x-kiro-attempt` 与时间戳。2.21.1 实测结论见 CLAUDE.md 速查表「kiro-cli 自己
 * 怎么处理 5xx/429」。
 */

import fs from 'node:fs';
import http from 'node:http';
import {
  buildAssistantResponseFrame,
  buildContextUsageFrame,
  buildMetadataFrame,
  buildMeteringFrame,
  buildToolUseFrame,
} from '../helpers/event-stream.js';

/**
 * 落盘前的脱敏,口径与 `scripts/capture-kiro-cli.sh` 的 `redactHeaders` 一致:
 * `authorization` / `host` 直接丢弃,profile ARN 替换成零账号占位符。
 *
 * ★ 不是可选项:`raw.json` 的**全部用途**就是被人打开、复制、贴进 issue 或提交历史,
 * 而它记的是真实凭据下的真实请求。抓包脚本早就这么做了,这个探针漏了同一道。
 */
const REDACTED_ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/REDACTED';

function redactHeaders(h: http.IncomingHttpHeaders): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'authorization' || k === 'host') continue;
    out[k] = typeof v === 'string' && v.startsWith('arn:aws:codewhisperer:') ? REDACTED_ARN : v;
  }
  return out;
}

/** body 里的 profileArn 同样脱敏(GAR 请求体每次都带)。 */
function redactBodyText(text: string): string {
  return text.replace(/arn:aws:codewhisperer:[^"'\s]+/g, REDACTED_ARN);
}

const DIR = process.env.PROBE_DIR ?? '/tmp/kiro-probe';
const PORT = Number(process.env.PROBE_PORT ?? 18445);
/** 让模型「调用」的工具名；空串 = 只回一段普通文本。 */
const PROBE_TOOL = process.env.PROBE_TOOL ?? '';
const PROBE_TOOL_INPUT = process.env.PROBE_TOOL_INPUT ?? '{}';
/** GAR 返回的 HTTP 状态码；200 = 正常返回伪造流。 */
const PROBE_STATUS = Number(process.env.PROBE_STATUS ?? 200);
/** 附加到非 2xx 响应上的头，例如 `retry-after: 7`。 */
const PROBE_HEADERS: Record<string, string> = process.env.PROBE_RESP_HEADERS
  ? JSON.parse(process.env.PROBE_RESP_HEADERS)
  : {};
const PROBE_BODY = process.env.PROBE_RESP_BODY ?? '{"message":"probe"}';
/**
 * 伪造流的收尾形态。`full`(默认)= 真实上游的完整尾段 metadata → contextUsage →
 * metering;`text-eof` = 只发正文就 EOF(帧边界干净截断,无任何尾帧),用来观察
 * kiro-cli 自己把这种流当「说完了」还是当故障(重试 / 报错)。
 */
const PROBE_STREAM_SHAPE = process.env.PROBE_STREAM_SHAPE ?? 'full';

fs.mkdirSync(DIR, { recursive: true });
const records: unknown[] = [];
let garCount = 0;

const metering = (): Buffer =>
  buildMeteringFrame({ unit: 'credit', unitPlural: 'credits', usage: 0.01 });

/** 伪造一条完整的助手响应流：可选 tool_use + 收尾帧。 */
function fakeStream(): Buffer {
  const frames: Buffer[] = [];
  if (PROBE_TOOL) {
    frames.push(buildAssistantResponseFrame('好的，我来查一下。'));
    frames.push(buildToolUseFrame(PROBE_TOOL, `tooluse_probe_${garCount}`, PROBE_TOOL_INPUT, true));
  } else {
    frames.push(buildAssistantResponseFrame('探针回复。'));
  }
  if (PROBE_STREAM_SHAPE === 'text-eof') return Buffer.concat(frames);
  frames.push(buildMetadataFrame());
  frames.push(buildContextUsageFrame(5));
  frames.push(metering());
  return Buffer.concat(frames);
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const target = String(req.headers['x-amz-target'] ?? '(none)');
    const text = redactBodyText(body.toString('utf-8'));
    records.push({
      ts: new Date().toISOString(),
      method: req.method,
      url: req.url,
      target,
      headers: redactHeaders(req.headers),
      bodyText: text.length > 400_000 ? `${text.slice(0, 400_000)}…[TRUNCATED]` : text,
      bodyLength: body.length,
    });
    fs.writeFileSync(`${DIR}/raw.json`, JSON.stringify(records, null, 2));

    const mk = (id: string) => ({
      modelName: id,
      modelId: id,
      displayName: id,
      description: 'mock',
      contextWindowTokens: 200000,
      rateMultiplier: 1,
      rateUnit: 'REQUEST',
    });

    if (target.endsWith('ListAvailableModels')) {
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify({ models: [mk('auto')], defaultModel: mk('auto') }));
      return;
    }
    if (target.endsWith('GetProfile')) {
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(
        JSON.stringify({
          arn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/MOCK',
          profileName: 'MOCK',
        }),
      );
      return;
    }
    if (target.endsWith('GenerateAssistantResponse')) {
      garCount++;
      if (PROBE_STATUS !== 200) {
        res.writeHead(PROBE_STATUS, {
          'content-type': 'application/x-amz-json-1.0',
          ...PROBE_HEADERS,
        });
        res.end(PROBE_BODY);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
      res.end(fakeStream());
      return;
    }
    // InvokeMCP 等其余：回一个 JSON-RPC 成功壳，够 kiro-cli 继续走下去
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        result: { content: [{ type: 'text', text: 'probe result' }], isError: false },
      }),
    );
  });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(
    `probe listening on ${PORT} (tool=${PROBE_TOOL || '-'} status=${PROBE_STATUS} shape=${PROBE_STREAM_SHAPE})\n`,
  );
});
