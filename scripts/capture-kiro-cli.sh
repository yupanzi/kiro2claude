#!/usr/bin/env bash
#
# capture-kiro-cli.sh —— 在本地捕获真实 kiro-cli 发出的 HTTP 请求头与 body，
# 生成 fixtures/kiro-cli-profile.json。生成后 kiro2claude 启动时会优先读取该文件
# 来模拟与 kiro-cli 完全一致的请求形态。
#
# 工作原理：
#   1. 临时把 kiro-cli 的 endpoint 设置重定向到本地 HTTP 监听端口（明文），
#      这样就不需要 TLS MITM / 证书注入。kiro-cli 2.7.0 起 endpoint 按服务
#      拆成多个 settings key，必须**同时**覆盖才能拦全：
#        - `api.codewhisperer.service` → runtime 非流式（GetProfile /
#          ListAvailableModels / SendTelemetryEvent，host codewhisperer/q.*.amazonaws.com）
#        - `api.krs.service`           → streaming（GenerateAssistantResponse /
#          InvokeMCP，host runtime.*.kiro.dev）—— 不覆盖它，GAR 会直连真实上游，
#          既抓不到 streaming 请求形态，又会真实消耗 credits。
#        - `api.cps.service`           → control plane（profile 管理，host management.*.kiro.dev）
#   2. 启动一个 Node.js 监听器记录所有入站请求（headers + body）。
#   3. 驱动 kiro-cli 触发每类请求（ListAvailableModels / GetProfile /
#      GenerateAssistantResponse / SendTelemetryEvent / GetUsageLimits / InvokeMCP）。
#   4. 清理临时设置，把捕获结果转换为结构化 profile JSON。
#
# 前置条件：
#   - 本机已安装 kiro-cli（Linux 或 macOS）。
#   - 已完成 kiro-cli 登录（SQLite IdC / Social / Builder ID 都可，只要 whoami 能通过）。
#   - 已安装 node（任意 ≥18 版本）。
#
# 用法：
#   ./scripts/capture-kiro-cli.sh                    # 捕获并写入默认路径
#   ./scripts/capture-kiro-cli.sh --out path.json    # 自定义输出路径
#   KIRO2CLAUDE_CLI_BIN=/path/to/kiro-cli ./scripts/capture-kiro-cli.sh
#
# 生成的 fixture 中 Authorization / profileArn / 用户 cwd 等敏感信息会被
# 脱敏为占位符，可以放心提交到仓库。
#
# fixture 是 kiro-cli 版本的**唯一真相源**：这个脚本只更新 fixture，
# Dockerfile 通过 `pnpm docker:build` 自动从 fixture 派生版本号，
# FALLBACK_PROFILE 的 kiroCliVersion 永远是 'unknown'（不视作副本）。
# 升级流程因此变成纯粹的两步：
#   1) 跑这个脚本（更新 fixture）
#   2) git commit fixtures/

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

OUT_PATH="$PROJECT_ROOT/fixtures/kiro-cli-profile.json"
PORT=18443
KIRO2CLAUDE_CLI_BIN="${KIRO2CLAUDE_CLI_BIN:-kiro-cli}"

# kiro-cli 2.7.0 起按服务拆分的 endpoint settings key。全部指向本地 mock
# 才能拦全 runtime / streaming / control-plane 三类请求。未知 key（旧版
# kiro-cli 不认识 krs/cps）会被静默跳过，只有成功设置的记进 SET_KEYS 供 cleanup。
ENDPOINT_KEYS=(api.codewhisperer.service api.krs.service api.cps.service)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_PATH="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --bin)
      KIRO2CLAUDE_CLI_BIN="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v "$KIRO2CLAUDE_CLI_BIN" >/dev/null 2>&1; then
  if [[ "$KIRO2CLAUDE_CLI_BIN" == "kiro-cli" ]]; then
    echo "错误: 未找到 kiro-cli，请先安装（参见 https://kiro.dev/docs/cli/installation/）" >&2
  else
    echo "错误: 未找到 $KIRO2CLAUDE_CLI_BIN" >&2
  fi
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node（需要 Node.js ≥18）" >&2
  exit 1
fi

if ! "$KIRO2CLAUDE_CLI_BIN" whoami >/dev/null 2>&1; then
  echo "错误: kiro-cli whoami 失败，请先登录 (kiro-cli login)" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"
# GNU / BSD mktemp 的 `-t` 语义不一样，最小公约数写法是
# `mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX"`：macOS (BSD) 和 Linux (GNU)
# 都接受这种绝对路径模板。
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/kiro-cli-capture.XXXXXX")"
trap 'cleanup' EXIT INT TERM

CAPTURE_FILE="$WORKDIR/raw.json"
SERVER_PID=""
# 实际成功设置的 endpoint key（cleanup 据此精确还原，避免删未设置的 key）。
# 顶部声明，保证 trap 在脚本任意早期失败时引用都安全（set -u 下空数组也合法）。
declare -a SET_KEYS=()

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${#SET_KEYS[@]}" -gt 0 ]]; then
    echo "→ 恢复 kiro-cli 设置 (删除 endpoint 覆盖)"
    for k in "${SET_KEYS[@]}"; do
      "$KIRO2CLAUDE_CLI_BIN" settings --delete "$k" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$WORKDIR"
}

# ---------------------------------------------------------------------------
# 1) 启动本地捕获服务器
# ---------------------------------------------------------------------------
cat > "$WORKDIR/server.cjs" <<'NODE_EOF'
const http = require('http');
const fs = require('fs');
const path = process.env.CAPTURE_FILE;
const port = parseInt(process.env.CAPTURE_PORT || '18443', 10);
const records = [];
// 对每个 x-amz-target + path 只保留首条，避免 retry 重复膨胀
const seen = new Set();

function writeOut() {
  fs.writeFileSync(path, JSON.stringify(records, null, 2));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const target = req.headers['x-amz-target'] || '(none)';
    const key = `${req.method} ${req.url.split('?')[0]} ${target}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push({
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText: (() => { try { return body.toString('utf-8'); } catch { return null; } })(),
        bodyBase64: body.toString('base64'),
        bodyLength: body.length,
      });
      writeOut();
    }
    // 对 ListAvailableModels 返回合法响应让流程继续往下走到 GenerateAssistantResponse
    if (String(target).endsWith('ListAvailableModels')) {
      const ok = JSON.stringify({
        models: [{
          modelName: 'auto',
          modelId: 'auto',
          displayName: 'Auto',
          description: 'mock',
          contextWindowTokens: 200000,
          rateMultiplier: 1,
          rateUnit: 'REQUEST',
        }],
        defaultModel: {
          modelName: 'auto',
          modelId: 'auto',
          displayName: 'Auto',
          description: 'mock',
          contextWindowTokens: 200000,
          rateMultiplier: 1,
          rateUnit: 'REQUEST',
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.0' });
      res.end(ok);
      return;
    }
    if (String(target).endsWith('GetProfile')) {
      res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/MOCK', profileName: 'MOCK' }));
      return;
    }
    // 其它请求返回错误即可，我们只关心请求本身
    res.writeHead(500, { 'Content-Type': 'application/x-amz-json-1.0' });
    res.end(JSON.stringify({ __type: 'InternalServerException', message: 'capture-only' }));
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('LISTEN\n');
});
NODE_EOF

echo "→ 启动本地捕获服务器 (127.0.0.1:$PORT)"
CAPTURE_FILE="$CAPTURE_FILE" CAPTURE_PORT="$PORT" node "$WORKDIR/server.cjs" > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

# 等捕获服务器就绪
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q LISTEN "$WORKDIR/server.log" 2>/dev/null; then break; fi
  sleep 0.1
done
if ! grep -q LISTEN "$WORKDIR/server.log" 2>/dev/null; then
  echo "错误: 捕获服务器启动失败，日志:" >&2
  cat "$WORKDIR/server.log" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2) 注入 endpoint 覆盖（按服务拆分的多个 key，全部指向本地 mock）
# ---------------------------------------------------------------------------
SETTING_VALUE="{\"endpoint\":\"http://127.0.0.1:$PORT\",\"region\":\"us-east-1\"}"
for k in "${ENDPOINT_KEYS[@]}"; do
  if "$KIRO2CLAUDE_CLI_BIN" settings "$k" "$SETTING_VALUE" >/dev/null 2>&1; then
    echo "→ 设置 kiro-cli $k = $SETTING_VALUE"
    SET_KEYS+=("$k")
  else
    echo "→ 跳过 $k（当前 kiro-cli 不接受该 key，旧版本属正常）"
  fi
done
if [[ "${#SET_KEYS[@]}" -eq 0 ]]; then
  echo "错误: 没有任何 endpoint key 设置成功，无法把 kiro-cli 重定向到本地 mock；" >&2
  echo "      继续抓包会直连真实上游并消耗 credits。中止。" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3) 驱动 kiro-cli 触发各类请求
# ---------------------------------------------------------------------------
echo "→ 触发 chat --no-interactive (会捕获 ListAvailableModels + GenerateAssistantResponse + SendTelemetryEvent)"
"$KIRO2CLAUDE_CLI_BIN" chat --no-interactive --trust-tools= "ping" >/dev/null 2>&1 || true

# profile 命令独立会打一次 ListAvailableProfiles + GetProfile
echo "→ 触发 profile (捕获 ListAvailableProfiles / GetProfile)"
"$KIRO2CLAUDE_CLI_BIN" profile >/dev/null 2>&1 || true

# 等捕获落盘
sleep 0.5

if [[ ! -s "$CAPTURE_FILE" ]]; then
  echo "错误: 没有捕获到任何请求，检查 kiro-cli 是否能正常联网调用" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4) 规范化生成 profile JSON
# ---------------------------------------------------------------------------
echo "→ 规范化为 profile JSON: $OUT_PATH"

KIRO2CLAUDE_CLI_VERSION="$("$KIRO2CLAUDE_CLI_BIN" --version 2>/dev/null | awk '{print $NF}')"
: "${KIRO2CLAUDE_CLI_VERSION:=unknown}"

KIRO2CLAUDE_CAPTURE_CWD="$PROJECT_ROOT" KIRO2CLAUDE_CAPTURE_HOME="$HOME" \
  node - "$CAPTURE_FILE" "$OUT_PATH" "$KIRO2CLAUDE_CLI_VERSION" <<'NODE_EOF'
const fs = require('fs');
const [,, rawPath, outPath, kiroCliVersion] = process.argv;
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));

function findFirst(targetSuffix) {
  return raw.find((r) => {
    const t = r.headers['x-amz-target'] || '';
    return t.endsWith(targetSuffix);
  });
}

const gar = findFirst('.GenerateAssistantResponse');
const telem = findFirst('.SendTelemetryEvent');
const listModels = findFirst('.ListAvailableModels');
const getProfile = findFirst('.GetProfile');

// 找一个具备完整 UA 的样本；优先用 streaming 的
const streamingSample = gar || raw.find((r) => (r.headers['x-amz-target'] || '').includes('Streaming'));
const runtimeSample = listModels || getProfile || telem || raw.find((r) => !(r.headers['x-amz-target'] || '').includes('Streaming'));

function extractUaTemplate(ua) {
  if (!ua) return null;
  // 1) api/{service}/{ver} 的 service 部分抽成 `{service}`
  // 2) os/{macos|linux|windows} 抽成 `{os}`，这样在 mac 抓出来的 fixture
  //    部署到 linux 容器里也不会暴露。runtime 会按 process.platform 还原。
  return ua.replace(/api\/[a-z]+\//i, 'api/{service}/').replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
}

function redactBody(bodyText) {
  if (!bodyText) return null;
  let body;
  try { body = JSON.parse(bodyText); } catch { return null; }
  const visit = (obj) => {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (k === 'profileArn' && typeof obj[k] === 'string') {
          obj[k] = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/REDACTED';
        } else if (k === 'currentWorkingDirectory' && typeof obj[k] === 'string') {
          obj[k] = '<cwd>';
        } else if (k === 'clientId' && typeof obj[k] === 'string' && obj[k].length > 10) {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'clientToken' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'conversationId' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'messageId' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'agentContinuationId' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'operatingSystem' && typeof obj[k] === 'string') {
          obj[k] = '{os}';
        } else if (k === 'content' && typeof obj[k] === 'string') {
          // 1) 归一化 kiro-cli 注入的"Current time: <ISO with TZ>"——每次 capture
          //    时间不同，留下来会让重抓 fixture 制造无意义 diff。
          obj[k] = obj[k].replace(
            /Current time: \w+, \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+[+-]\d{2}:\d{2}/g,
            'Current time: <captured_at>',
          );
          // 2) 脱敏 kiro-cli "file context attachment" —— 形如 "[/abs/path]\n<file 内容>"
          //    会暴露 cwd / 用户名，且 runtime 永远不会发这种自动注入的 history
          //    内容，整段替换成稳定占位符即可。
          obj[k] = obj[k].replace(
            /\[\/[^\]\n]+\]\n[\s\S]*?(?=\n--- CONTEXT ENTRY END ---|$)/g,
            '[<context_file>]\n<content elided>',
          );
          // 3) 兜底：把任何遗留的 cwd / $HOME 路径前缀替换成占位符
          const cwd = process.env.KIRO2CLAUDE_CAPTURE_CWD;
          if (cwd) obj[k] = obj[k].split(cwd).join('<cwd>');
          const home = process.env.KIRO2CLAUDE_CAPTURE_HOME;
          if (home) obj[k] = obj[k].split(home).join('<home>');
          // 4) 截断过长的 prompt / tool spec 描述，避免 fixture 膨胀
          if (obj[k].length > 200) obj[k] = obj[k].slice(0, 200) + '… <truncated>';
        } else if (k === 'description' && typeof obj[k] === 'string' && obj[k].length > 200) {
          obj[k] = obj[k].slice(0, 200) + '… <truncated>';
        } else {
          visit(obj[k]);
        }
      }
    }
  };
  visit(body);
  return body;
}

function redactUrl(p) {
  if (!p) return p;
  // query 里的 profileArn 也脱敏
  return p.replace(/profileArn=[^&]+/g, 'profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A000000000000%3Aprofile%2FREDACTED');
}

function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'authorization' || k === 'host' || k === 'content-length') continue;
    if (k === 'amz-sdk-invocation-id' || k === 'amz-sdk-request') continue;
    if (k === 'x-amzn-codewhisperer-optout') {
      // 项目隐私硬约束：始终 opt-out，绝不让对话数据被上游用于训练 / 服务改进。
      // 无论抓包机的 `kiro-cli settings telemetry.enabled` 是什么，一律归一化为 'true'。
      // 这不是随抓包环境漂移的设置，而是代理对上游的固定立场（与 os/cwd 脱敏归一化同列）。
      out[k] = 'true';
      continue;
    }
    if ((k === 'user-agent' || k === 'x-amz-user-agent') && typeof v === 'string') {
      // samples 保留原始 service 名（codewhispererruntime / codewhispererstreaming），
      // 只替换 os 做平台脱敏；{service} 模板化仅用于 top-level userAgent / xAmzUserAgent
      out[k] = v.replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 从 body 推断 origin / agentTaskType / chatTriggerType / envState
let origin = 'KIRO_CLI';
let agentTaskType = 'vibe';
let chatTriggerType = 'MANUAL';
// operatingSystem 一律写成 `{os}` 占位符：本机抓出来的值已经被 kiro-cli
// 固定成了 macos/linux/windows 之一，但 fixture 应该跨平台可用，runtime
// 再按 process.platform 替换。
let operatingSystem = '{os}';
if (gar) {
  const body = redactBody(gar.bodyText);
  if (body && body.conversationState) {
    const cs = body.conversationState;
    agentTaskType = cs.agentTaskType || agentTaskType;
    chatTriggerType = cs.chatTriggerType || chatTriggerType;
    const uim = (cs.currentMessage && cs.currentMessage.userInputMessage) || {};
    if (uim.origin) origin = uim.origin;
  }
}

const staticHeaders = {};
const srcHeaders = (streamingSample || runtimeSample || raw[0]).headers;
for (const k of ['content-type', 'accept', 'accept-encoding']) {
  if (srcHeaders[k] != null) staticHeaders[k] = srcHeaders[k];
}
// 隐私硬约束：optout 故意不在上面的复制列表里——不取抓包值，一律强制 'true'。
// staticHeaders 会被原样塞进代理发往上游的每个请求（provider.ts / token-manager.ts
// 都 `...profile.staticHeaders`），强制 opt-out 训练，不随抓包机 telemetry.enabled 漂移。
staticHeaders['x-amzn-codewhisperer-optout'] = 'true';

const amzTargets = {};
if (gar) amzTargets.generateAssistantResponse = gar.headers['x-amz-target'];
if (telem) amzTargets.sendTelemetryEvent = telem.headers['x-amz-target'];
if (listModels) amzTargets.listAvailableModels = listModels.headers['x-amz-target'];
if (getProfile) amzTargets.getProfile = getProfile.headers['x-amz-target'];

// 稳定化输出：
// 1) 递归按 key 字母序排序所有对象（JSON.stringify 遵循插入顺序，要稳定
//    输出就必须先按已排序的 key 重建对象）。数组顺序由上层单独决定。
// 2) samples 数组按 (target, method, urlPath) 排序——真实捕获顺序会受
//    kiro-cli 内部调度 / retry 影响，不保证稳定。
// 3) 不写入 capturedAt 时间戳：把易变字段塞进 fixture 只会让每次重跑都
//    凭空制造一行 diff，污染 profile 的语义 diff。捕获时间不是 fixture
//    要表达的信息，省掉它能让相同输入稳定产出相同 JSON。
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

const samples = raw
  .map((r) => ({
    target: r.headers['x-amz-target'] || null,
    method: r.method,
    urlPath: redactUrl(r.url),
    headers: redactHeaders(r.headers),
    body: redactBody(r.bodyText),
  }))
  .sort((a, b) => {
    // 用 \u0000 拼接作为 tie-breaker，避免 target 为空时串到相邻字段
    const ka = `${a.target || ''}\u0000${a.method}\u0000${a.urlPath || ''}`;
    const kb = `${b.target || ''}\u0000${b.method}\u0000${b.urlPath || ''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

const profile = {
  kiroCliVersion,
  note: [
    'Generated by scripts/capture-kiro-cli.sh from a real local kiro-cli instance.',
    'Contains request header templates and body semantic fields sent by kiro-cli to Kiro / CodeWhisperer upstream.',
    'Sensitive fields (Authorization / profileArn / cwd / clientId / conversation id) have been redacted.',
    'All objects sorted by key alphabetically; samples sorted by (target, method, urlPath). Identical input produces identical JSON.',
  ],
  staticHeaders,
  userAgent: extractUaTemplate((streamingSample || runtimeSample).headers['user-agent']),
  xAmzUserAgent: extractUaTemplate((streamingSample || runtimeSample).headers['x-amz-user-agent']),
  amzTargets,
  body: {
    origin,
    agentTaskType,
    chatTriggerType,
    envState: { operatingSystem },
  },
  samples,
};

fs.writeFileSync(outPath, JSON.stringify(sortKeys(profile), null, 2) + '\n');
console.log(`✓ 写入 ${outPath}`);
console.log(`  kiroCliVersion: ${kiroCliVersion}`);
console.log(`  user-agent    : ${profile.userAgent}`);
console.log(`  x-amz-user-agent: ${profile.xAmzUserAgent}`);
console.log(`  origin        : ${profile.body.origin}`);
console.log(`  os            : ${profile.body.envState.operatingSystem}`);
console.log(`  targets       : ${Object.keys(profile.amzTargets).length} 个`);
NODE_EOF

echo "→ 完成。fixture 是 kiro-cli 版本号的唯一真相源。"
echo "  下一步："
echo "    git diff fixtures/kiro-cli-profile.json   # 检视改动"
echo "    pnpm docker:build -- -t kiro2claude  # 验证新版本能 build"
echo "    git add fixtures/ && git commit"
