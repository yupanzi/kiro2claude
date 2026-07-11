#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# kiro2claude × Claude Code CLI 兼容性测试套件
#
# 通过 Docker 运行真实的 Claude Code CLI,经 kiro2claude 网关
# 完成端到端调用,覆盖 4 大类场景:
#   - 非流式 JSON 输出
#   - stream-json + verbose 流式
#   - 工具使用 (--allowedTools Read + 挂载 workspace)
#   - 多模型矩阵 (opus-4.7 / opus-4.6 / sonnet-4.6)
# 加一个 00-version sanity check 验证镜像版本号一致。
#
# 用法见 ./test.sh --help
# ─────────────────────────────────────────────────────────────

set -euo pipefail
IFS=$'\n\t'

# ── 常量 ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION_FILE="$SCRIPT_DIR/VERSION"
DEFAULT_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE" 2>/dev/null || echo 'latest')"

PROBE_PORT="${KIRO2CLAUDE_PROBE_PORT:-8080}"
PROBE_TIMEOUT=3

TEST_CONTAINER_PREFIX="kiro2claude-cc-test"
TEST_IMAGE_REPO="kiro2claude-cc-test"

ALL_CASES=("00-version" "01-ping" "02-stream" "03-tool-use" "04-models")

# ── 颜色 ─────────────────────────────────────────────────────

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
NC=$'\033[0m'

# ── 参数解析 ─────────────────────────────────────────────────

TOKEN=""
BASE_URL=""
CC_VERSION=""
MODEL=""
SINGLE_CASE=""
FORCE_BUILD=false
KEEP_VOLUME=false

usage() {
    cat <<EOF
${CYAN}kiro2claude × Claude Code CLI 自动化测试${NC}

用法: $0 [选项]

选项:
  -t, --token TOKEN        kiro2claude API key (默认: 仓库根 .env 里的 KIRO2CLAUDE_API_KEY)
  -u, --url URL            网关 base URL (默认: 自动 probe localhost:${PROBE_PORT})
  -v, --version VERSION    Claude Code 版本 (默认: $DEFAULT_VERSION, 源: $VERSION_FILE)
  -m, --model MODEL        04-models 单独跑某个模型 (默认: 全矩阵)
      --case NAME          只跑某个 case ($(IFS=,; echo "${ALL_CASES[*]}"))
      --build              强制 rebuild 镜像
      --keep-volume        测试结束保留 docker volume (默认: 清掉)
      --no-color           关闭 ANSI 颜色
  -h, --help               显示帮助

退出码:
  0   全部通过
  1   任一 case 失败 / 依赖缺失 / 网关不可达
  130 Ctrl-C 中断 (清理后退出)

示例:
  ./test.sh                              # 全套
  ./test.sh --case 01-ping               # 只跑 ping
  ./test.sh -m claude-opus-4.7 --case 04-models    # 多模型矩阵里只跑 4.7
  ./test.sh -v X.Y.Z --build             # 跨版本回归（X.Y.Z 替换为实际 semver）
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--token)        TOKEN="$2"; shift 2 ;;
        -u|--url)          BASE_URL="$2"; shift 2 ;;
        -v|--version)      CC_VERSION="$2"; shift 2 ;;
        -m|--model)        MODEL="$2"; shift 2 ;;
        --case)            SINGLE_CASE="$2"; shift 2 ;;
        --build)           FORCE_BUILD=true; shift ;;
        --keep-volume)     KEEP_VOLUME=true; shift ;;
        --no-color)        RED='' GREEN='' YELLOW='' CYAN='' DIM='' BOLD='' NC=''; shift ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "未知参数: $1" >&2; usage >&2; exit 1 ;;
    esac
done

CC_VERSION="${CC_VERSION:-${CLAUDE_CODE_VERSION:-$DEFAULT_VERSION}}"
TEST_IMAGE_TAG="${TEST_IMAGE_REPO}:${CC_VERSION}"

# ── 日志工具 ─────────────────────────────────────────────────

log_info() { printf "${CYAN}[i]${NC} %s\n" "$*"; }
log_pass() { printf "${GREEN}[✔]${NC} %s\n" "$*"; }
log_fail() { printf "${RED}[✘]${NC} %s\n" "$*"; }
log_warn() { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
log_dim()  { printf "${DIM}    %s${NC}\n" "$*"; }
fatal()    { log_fail "$*"; exit 1; }

# ── 读取 .env 里的 KIRO2CLAUDE_API_KEY (无 dotenv 依赖) ──────

read_env_key() {
    local key="$1" file="$2"
    local line val
    line=$(grep -E "^${key}=" "$file" 2>/dev/null | head -1) || return 1
    [[ -z "$line" ]] && return 1
    val="${line#${key}=}"
    val="${val#\"}"; val="${val%\"}"
    val="${val#\'}"; val="${val%\'}"
    printf '%s' "$val"
}

if [[ -z "$TOKEN" ]]; then
    if [[ -f "$REPO_ROOT/.env" ]]; then
        TOKEN="$(read_env_key KIRO2CLAUDE_API_KEY "$REPO_ROOT/.env" || true)"
    fi
    [[ -z "$TOKEN" ]] && fatal "缺 token: 传 -t 或在 $REPO_ROOT/.env 设置 KIRO2CLAUDE_API_KEY"
fi

# ── 依赖检查 ─────────────────────────────────────────────────

check_deps() {
    command -v docker >/dev/null 2>&1 || fatal "docker 不在 PATH"
    command -v jq >/dev/null 2>&1 || fatal "jq 不在 PATH (macOS: brew install jq, Linux: apt install jq)"
    command -v curl >/dev/null 2>&1 || fatal "curl 不在 PATH"
    docker info >/dev/null 2>&1 || fatal "docker daemon 未运行"
}

# ── 网关 probe (智能检测 + 失败立即报错) ─────────────────────

PROBE_URL=""
CONTAINER_BASE_URL=""
NETWORK_ARGS=()

probe_gateway() {
    local probe_target
    if [[ -n "$BASE_URL" ]]; then
        # 用户传 -u: 宿主机视角用 127.0.0.1 替换 host.docker.internal 以确保 probe 通
        probe_target="${BASE_URL/host.docker.internal/127.0.0.1}/health"
    else
        probe_target="http://127.0.0.1:${PROBE_PORT}/health"
    fi
    log_info "probing 网关: ${probe_target}"
    if ! curl -sf -m "$PROBE_TIMEOUT" "$probe_target" >/dev/null 2>&1; then
        fatal "kiro2claude 网关不可达: ${probe_target}
  → 启动方式之一:
    pnpm dev                                            (开发模式)
    docker run -d -p 8080:8080 --env-file .env kiro2claude  (容器模式)
  → 或显式传 -u <已运行的 URL>"
    fi
    PROBE_URL="$probe_target"
    log_pass "网关健康: ${PROBE_URL}"
}

compute_network_args() {
    local os
    os=$(uname -s)

    if [[ -n "$BASE_URL" ]]; then
        CONTAINER_BASE_URL="$BASE_URL"
    else
        case "$os" in
            Linux)    CONTAINER_BASE_URL="http://127.0.0.1:${PROBE_PORT}/claude" ;;
            *)        CONTAINER_BASE_URL="http://host.docker.internal:${PROBE_PORT}/claude" ;;
        esac
    fi

    if [[ "$CONTAINER_BASE_URL" == *"127.0.0.1"* || "$CONTAINER_BASE_URL" == *"localhost"* ]]; then
        if [[ "$os" == "Linux" ]]; then
            NETWORK_ARGS=(--network host)
        else
            # macOS 上 --network host 不工作 (Docker Desktop 限制); 强制用户改 host.docker.internal
            fatal "macOS 不支持 --network host. 改用 host.docker.internal:${PROBE_PORT} 或省略 -u"
        fi
    else
        NETWORK_ARGS=(--add-host=host.docker.internal:host-gateway)
    fi

    log_info "容器内 base URL: ${CONTAINER_BASE_URL}"
    log_info "网络参数: ${NETWORK_ARGS[*]}"
}

# ── 镜像构建 ─────────────────────────────────────────────────

image_exists() {
    docker image inspect "$TEST_IMAGE_TAG" >/dev/null 2>&1
}

build_image_if_needed() {
    if $FORCE_BUILD || ! image_exists; then
        local build_args=(--build-arg "CLAUDE_CODE_VERSION=${CC_VERSION}" -t "$TEST_IMAGE_TAG")
        # latest 模式下 build-arg 字符串不变,docker layer cache 会命中,实际 npm install 不会重拉
        # 必须 --pull --no-cache 强制重做 RUN 层,真正同步到 npm latest
        if [[ "$CC_VERSION" == "latest" ]]; then
            build_args+=(--pull --no-cache)
            log_info "latest 模式: 自动加 --pull --no-cache 强制拉新"
        fi
        log_info "构建镜像 ${TEST_IMAGE_TAG} (CC ${CC_VERSION}) ..."
        docker build "${build_args[@]}" "$SCRIPT_DIR" >&2
        log_pass "镜像构建完成"
    else
        log_info "使用已有镜像 ${TEST_IMAGE_TAG}"
    fi
}

# ── 生命周期清理 (用户的核心要求: 不遗漏垃圾) ────────────────

WORKSPACE_TEMPDIRS=()
STDERR_TEMPFILES=()

cleanup_orphans() {
    # 关掉/删掉所有以测试前缀开头的容器
    local orphan_ids
    orphan_ids=$(docker ps -a --filter "name=^${TEST_CONTAINER_PREFIX}-" -q 2>/dev/null || true)
    if [[ -n "$orphan_ids" ]]; then
        # shellcheck disable=SC2086
        docker rm -f $orphan_ids >/dev/null 2>&1 || true
    fi
    # 清临时 workspace 目录 (03-tool-use)
    local wd
    for wd in "${WORKSPACE_TEMPDIRS[@]+"${WORKSPACE_TEMPDIRS[@]}"}"; do
        [[ -d "$wd" ]] && rm -rf "$wd"
    done
    # 清 stderr 临时文件
    local sf
    for sf in "${STDERR_TEMPFILES[@]+"${STDERR_TEMPFILES[@]}"}"; do
        [[ -f "$sf" ]] && rm -f "$sf"
    done
}

handle_interrupt() {
    log_warn "中断收到, 正在清理 ..."
    cleanup_orphans
    exit 130
}

trap handle_interrupt INT TERM
trap cleanup_orphans EXIT

# 进入主流程前先清一次孤儿 (上次崩了的残留)
cleanup_orphans

# ── 测试结果记录 ────────────────────────────────────────────

RESULTS=()  # 每项: "name|status|duration|note"

record_result() {
    local name="$1" status="$2" dur="$3" note="${4:-}"
    RESULTS+=("${name}|${status}|${dur}|${note}")
}

pass_result() { record_result "$1" "pass" "$2" ""; log_pass "  $1 (${2}s)"; }
fail_result() { record_result "$1" "fail" "$2" "$3"; log_fail "  $1 (${2}s) — $3"; }

# ── 共享: 跑一个 docker run + 捕获 stdout/stderr ────────────

# 用法: run_in_container <name> <stderr_outvar> -- <args...>
# 通过 echo 把 stdout 返回; stderr 写入 mktemp 文件, 文件路径存入第二个参数所指向的变量
run_in_container() {
    local name="$1"; shift
    local stderr_var="$1"; shift
    [[ "$1" == "--" ]] && shift

    local stderr_file
    stderr_file=$(mktemp -t kiro2claude-cc-stderr-XXXXXX)
    STDERR_TEMPFILES+=("$stderr_file")
    printf -v "$stderr_var" '%s' "$stderr_file"

    docker run --rm \
        --name "${TEST_CONTAINER_PREFIX}-${name}" \
        -e "ANTHROPIC_AUTH_TOKEN=$TOKEN" \
        -e "ANTHROPIC_BASE_URL=$CONTAINER_BASE_URL" \
        "${NETWORK_ARGS[@]}" \
        "$@" \
        2>"$stderr_file"
}

dump_stderr_tail() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    log_dim "stderr (尾 10 行):"
    tail -10 "$file" | sed 's/^/      /' >&2 || true
}

# ── Case 00: 版本一致性 sanity check ────────────────────────

case_00_version() {
    local name="00-version"
    local start_ts end_ts dur stderr_file out rc=0 detected_ver
    start_ts=$(date +%s)

    # claude --version 输出本身就是 build 后真实安装版本号的 ground truth
    # —— 抽取它即可,不必再读 /etc/cc-version (会多一次 container 启动)
    out=$(run_in_container "$name" stderr_file -- \
        --entrypoint claude "$TEST_IMAGE_TAG" --version) || rc=$?

    end_ts=$(date +%s); dur=$((end_ts - start_ts))

    if [[ "$rc" -ne 0 ]]; then
        fail_result "$name" "$dur" "claude --version 非零退出"
        dump_stderr_tail "$stderr_file"
        return 1
    fi

    detected_ver=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' <<< "$out" | head -1 || true)
    if [[ -z "$detected_ver" ]]; then
        fail_result "$name" "$dur" "claude --version 输出未含合法 semver: $(head -c 200 <<< "$out")"
        return 1
    fi

    # pinned 模式: 实际安装的必须等于请求的; latest 模式: 抽出来是合法 semver 即过
    if [[ "$CC_VERSION" != "latest" && "$detected_ver" != "$CC_VERSION" ]]; then
        fail_result "$name" "$dur" "实际版本不匹配: want=${CC_VERSION} got=${detected_ver}"
        return 1
    fi

    log_dim "解析到的实际 CC 版本: ${detected_ver}"
    pass_result "$name" "$dur"
}

# ── Case 01: 非流式 ping (--output-format json) ─────────────

assert_ping_json() {
    local out="$1" name="$2" dur="$3"
    # 语义断言: 剥掉标点和空白后大小写归一, 严格等于 "PONG"
    # 避免 substring 假阳性 (如 "PONG-like ping failed" 也含 PONG)
    if ! jq -e '(.result // "" | ascii_upcase | gsub("[[:punct:][:space:]]"; "")) == "PONG"' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "result 经标点/空白归一后 ≠ PONG"
        log_dim "result: $(jq -r '.result // "<null>"' <<< "$out" 2>/dev/null | head -c 200)"
        return 1
    fi
    # 协议形态: 必须是 success 且非 error 且单轮
    if ! jq -e '.subtype == "success" and .is_error == false and .stop_reason == "end_turn"' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "result 非 success / is_error / stop_reason 异常"
        log_dim "got: $(jq -c '{subtype, is_error, stop_reason}' <<< "$out" 2>/dev/null)"
        return 1
    fi
    if ! jq -e '.session_id | type == "string" and (test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" ".session_id 不是合法 UUID"
        return 1
    fi
    if ! jq -e '.total_cost_usd | type == "number" and . > 0' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" ".total_cost_usd 缺失或 ≤ 0"
        return 1
    fi
    if ! jq -e '.usage.input_tokens | type == "number" and . > 0' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" ".usage.input_tokens 缺失或 ≤ 0"
        return 1
    fi
    if ! jq -e '.usage.output_tokens | type == "number" and . > 0' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" ".usage.output_tokens 缺失或 ≤ 0"
        return 1
    fi
    return 0
}

case_01_ping() {
    local name="01-ping"
    local start_ts end_ts dur stderr_file out rc=0
    start_ts=$(date +%s)

    out=$(run_in_container "$name" stderr_file -- \
        "$TEST_IMAGE_TAG" \
        -p "Reply with the single word PONG and nothing else." \
        --output-format json --model claude-opus-4.6) || rc=$?

    end_ts=$(date +%s); dur=$((end_ts - start_ts))

    if [[ "$rc" -ne 0 ]]; then
        fail_result "$name" "$dur" "docker run rc=${rc}"
        dump_stderr_tail "$stderr_file"
        return 1
    fi

    if ! assert_ping_json "$out" "$name" "$dur"; then
        dump_stderr_tail "$stderr_file"
        return 1
    fi
    pass_result "$name" "$dur"
}

# ── Case 02: 流式 SSE (stream-json + verbose) ───────────────

case_02_stream() {
    local name="02-stream"
    local start_ts end_ts dur stderr_file out rc=0
    start_ts=$(date +%s)

    out=$(run_in_container "$name" stderr_file -- \
        "$TEST_IMAGE_TAG" \
        -p "Count from 1 to 3, one number per line, no extra prose." \
        --output-format stream-json --verbose --include-partial-messages \
        --model claude-opus-4.6) || rc=$?

    end_ts=$(date +%s); dur=$((end_ts - start_ts))

    if [[ "$rc" -ne 0 ]]; then
        fail_result "$name" "$dur" "docker run rc=${rc}"
        dump_stderr_tail "$stderr_file"
        return 1
    fi

    # 至少一行 stream_event
    local stream_event_count
    stream_event_count=$(jq -c 'select(.type == "stream_event")' <<< "$out" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$stream_event_count" -lt 1 ]]; then
        fail_result "$name" "$dur" "未观察到 stream_event 行 (got=${stream_event_count})"
        log_dim "前 5 行: $(head -5 <<< "$out" | tr '\n' '|')"
        return 1
    fi

    # 至少一行 text_delta
    local text_delta_count
    text_delta_count=$(jq -c 'select(.event.delta.type? == "text_delta")' <<< "$out" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$text_delta_count" -lt 1 ]]; then
        fail_result "$name" "$dur" "未观察到 text_delta event (got=${text_delta_count})"
        return 1
    fi

    # 最后一行 type=result 且 subtype=success
    local last_summary
    last_summary=$(tail -1 <<< "$out" | jq -c '{type, subtype, stop_reason, result}' 2>/dev/null || echo "{}")
    if ! jq -e '.type == "result" and .subtype == "success" and .stop_reason == "end_turn"' <<< "$last_summary" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "末行非 success result 状态"
        log_dim "last: ${last_summary}"
        return 1
    fi

    # 语义断言: 重组 text_delta 拼接的文本必须包含 1, 2, 3 全部三个数字
    # (顺序+其它字符不强求, 但 1/2/3 必须都出现)
    local reconstructed
    reconstructed=$(jq -rj 'select(.event.delta.type? == "text_delta") | .event.delta.text' <<< "$out" 2>/dev/null || echo "")
    if ! { [[ "$reconstructed" == *"1"* ]] && [[ "$reconstructed" == *"2"* ]] && [[ "$reconstructed" == *"3"* ]]; }; then
        fail_result "$name" "$dur" "重组的 text_delta 未包含 1/2/3 全部三个数字"
        log_dim "reconstructed: $(printf '%q' "$reconstructed" | head -c 200)"
        return 1
    fi

    # 一致性: 重组文本应等于末行 result 字段 (网关 SSE 转译没丢字符的强证据)
    local final_result
    final_result=$(jq -r '.result // ""' <<< "$last_summary" 2>/dev/null)
    if [[ "$reconstructed" != "$final_result" ]]; then
        fail_result "$name" "$dur" "重组流式文本 ≠ 末行 result 字段 (SSE 丢/重字符迹象)"
        log_dim "stream: $(printf '%q' "$reconstructed" | head -c 80)"
        log_dim "final:  $(printf '%q' "$final_result" | head -c 80)"
        return 1
    fi

    pass_result "$name" "$dur"
}

# ── Case 03: 工具使用 (--allowedTools Read + 挂载 workspace) ─

case_03_tool_use() {
    local name="03-tool-use"
    local start_ts end_ts dur stderr_file out rc=0
    start_ts=$(date +%s)

    local workspace
    workspace=$(mktemp -d -t kiro2claude-cc-ws-XXXXXX)
    WORKSPACE_TEMPDIRS+=("$workspace")
    echo "purplemonkey" > "$workspace/secret.txt"

    stderr_file=$(mktemp -t kiro2claude-cc-stderr-XXXXXX)
    STDERR_TEMPFILES+=("$stderr_file")

    out=$(docker run --rm \
        --name "${TEST_CONTAINER_PREFIX}-${name}" \
        -e "ANTHROPIC_AUTH_TOKEN=$TOKEN" \
        -e "ANTHROPIC_BASE_URL=$CONTAINER_BASE_URL" \
        -v "$workspace:/workspace:ro" -w /workspace \
        "${NETWORK_ARGS[@]}" \
        "$TEST_IMAGE_TAG" \
        -p "Read the file secret.txt in the current directory and output ONLY its content verbatim, no other words, no punctuation." \
        --allowedTools "Read" \
        --output-format json --model claude-opus-4.6 \
        2>"$stderr_file") || rc=$?

    end_ts=$(date +%s); dur=$((end_ts - start_ts))

    if [[ "$rc" -ne 0 ]]; then
        fail_result "$name" "$dur" "docker run rc=${rc}"
        dump_stderr_tail "$stderr_file"
        return 1
    fi

    # 严格语义: result 必须确切等于文件内容 "purplemonkey"
    # (剥标点空白后大小写归一, 不接受嵌入在解释性文字里)
    if ! jq -e '(.result // "" | ascii_upcase | gsub("[[:punct:][:space:]]"; "")) == "PURPLEMONKEY"' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "result ≠ 'purplemonkey' (Read 工具回环可能断了)"
        log_dim "result: $(jq -r '.result // "<null>"' <<< "$out" 2>/dev/null | head -c 200)"
        dump_stderr_tail "$stderr_file"
        return 1
    fi

    # tool 回环强证据: num_turns >= 2 表示 CC 至少做了一次 tool_use → tool_result → final
    # 仅 1 轮意味着上游直接吐 final 文本, 说明 Read 工具没被调用
    if ! jq -e '.num_turns >= 2' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "num_turns < 2 — Read 工具没被调用过 (CC 可能 hallucinate 了答案)"
        log_dim "num_turns=$(jq -r '.num_turns' <<< "$out"), permission_denials=$(jq -c '.permission_denials' <<< "$out")"
        return 1
    fi

    # 协议状态
    if ! jq -e '.subtype == "success" and .is_error == false and .stop_reason == "end_turn"' <<< "$out" >/dev/null 2>&1; then
        fail_result "$name" "$dur" "协议状态非 success"
        log_dim "got: $(jq -c '{subtype, is_error, stop_reason}' <<< "$out" 2>/dev/null)"
        return 1
    fi

    pass_result "$name" "$dur"
}

# ── Case 04: 多模型矩阵 ─────────────────────────────────────

case_04_models() {
    local name="04-models"
    local models=()
    if [[ -n "$MODEL" ]]; then
        models=("$MODEL")
    else
        models=("claude-opus-4.7" "claude-opus-4.6" "claude-sonnet-4.6")
    fi

    local all_ok=true
    local m
    for m in "${models[@]}"; do
        local case_label="04-models[${m}]"
        local m_sanitized="${m//[^a-zA-Z0-9-]/-}"
        local start_ts end_ts dur stderr_file out rc=0
        start_ts=$(date +%s)
        log_info "  → ${m}"

        out=$(run_in_container "${name}-${m_sanitized}" stderr_file -- \
            "$TEST_IMAGE_TAG" \
            -p "Reply with the single word PONG and nothing else." \
            --output-format json --model "$m") || rc=$?

        end_ts=$(date +%s); dur=$((end_ts - start_ts))

        if [[ "$rc" -ne 0 ]]; then
            fail_result "$case_label" "$dur" "docker run rc=${rc}"
            dump_stderr_tail "$stderr_file"
            all_ok=false
            continue
        fi

        # 严格相等 (剥标点空白后)
        if ! jq -e '(.result // "" | ascii_upcase | gsub("[[:punct:][:space:]]"; "")) == "PONG"' <<< "$out" >/dev/null 2>&1; then
            fail_result "$case_label" "$dur" "result 经归一后 ≠ PONG"
            log_dim "result: $(jq -r '.result // "<null>"' <<< "$out" 2>/dev/null | head -c 200)"
            all_ok=false
            continue
        fi
        # 协议状态 + usage 三件套 (reasoning native 4.7/4.8 不应掉这些字段)
        if ! jq -e '.subtype == "success" and .is_error == false and (.usage.input_tokens | type == "number" and . > 0) and (.usage.output_tokens | type == "number" and . > 0)' <<< "$out" >/dev/null 2>&1; then
            fail_result "$case_label" "$dur" "协议状态/usage 异常 (reasoning native 路径可能回归)"
            log_dim "got: $(jq -c '{subtype, is_error, usage: .usage | {input_tokens, output_tokens}}' <<< "$out" 2>/dev/null)"
            all_ok=false
            continue
        fi

        pass_result "$case_label" "$dur"
    done

    $all_ok
}

# ── 编排 ────────────────────────────────────────────────────

run_case_by_name() {
    local c="$1"
    case "$c" in
        00-version)  case_00_version || true ;;
        01-ping)     case_01_ping || true ;;
        02-stream)   case_02_stream || true ;;
        03-tool-use) case_03_tool_use || true ;;
        04-models)   case_04_models || true ;;
        *) fatal "未知 case: ${c} (可选: $(IFS=,; echo "${ALL_CASES[*]}"))" ;;
    esac
}

# ── 摘要 ────────────────────────────────────────────────────

print_summary() {
    local passed=0 failed=0
    echo
    printf "${CYAN}┌───────────────────────────────────────────────────────┐${NC}\n"
    printf "${CYAN}│${NC}  ${BOLD}Claude Code → kiro2claude 测试报告${NC}                  ${CYAN}│${NC}\n"
    printf "${CYAN}│${NC}  CC ${CC_VERSION}  |  URL: %-30s ${CYAN}│${NC}\n" "$CONTAINER_BASE_URL"
    printf "${CYAN}├───────────────────────────────────────────────────────┤${NC}\n"
    local r
    for r in "${RESULTS[@]+"${RESULTS[@]}"}"; do
        local rname rstatus rdur rnote
        rname=$(cut -d'|' -f1 <<< "$r")
        rstatus=$(cut -d'|' -f2 <<< "$r")
        rdur=$(cut -d'|' -f3 <<< "$r")
        rnote=$(cut -d'|' -f4 <<< "$r")
        if [[ "$rstatus" == "pass" ]]; then
            printf "${CYAN}│${NC} ${GREEN}✔${NC} %-28s ${DIM}%4ss${NC}                ${CYAN}│${NC}\n" "$rname" "$rdur"
            passed=$((passed + 1))
        else
            printf "${CYAN}│${NC} ${RED}✘${NC} %-28s ${DIM}%4ss${NC}                ${CYAN}│${NC}\n" "$rname" "$rdur"
            if [[ -n "$rnote" ]]; then
                printf "${CYAN}│${NC}   ${RED}└─ %-49s${NC} ${CYAN}│${NC}\n" "$(echo "$rnote" | head -c 49)"
            fi
            failed=$((failed + 1))
        fi
    done
    printf "${CYAN}└───────────────────────────────────────────────────────┘${NC}\n"
    echo
    if [[ "$failed" -gt 0 ]]; then
        printf "${RED}通过 ${passed} / 失败 ${failed}${NC}\n"
        return 1
    fi
    printf "${GREEN}全部通过 (${passed}/${passed})${NC}\n"
}

# ── main ────────────────────────────────────────────────────

main() {
    log_info "kiro2claude × Claude Code 测试套件"
    log_info "CC 版本: ${CC_VERSION}  |  镜像 tag: ${TEST_IMAGE_TAG}"

    check_deps
    probe_gateway
    compute_network_args
    build_image_if_needed

    local cases_to_run=()
    if [[ -n "$SINGLE_CASE" ]]; then
        cases_to_run=("$SINGLE_CASE")
    else
        cases_to_run=("${ALL_CASES[@]}")
    fi

    echo
    log_info "开始执行 ${#cases_to_run[@]} 个 case"
    echo

    local c
    for c in "${cases_to_run[@]}"; do
        run_case_by_name "$c"
        echo
    done

    if print_summary; then
        exit 0
    else
        exit 1
    fi
}

main "$@"
