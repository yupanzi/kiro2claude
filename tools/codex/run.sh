#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# kiro2claude × OpenAI Codex CLI Docker 启动脚本(开发测试用)
# 通过 kiro2claude 网关的 OpenAI Responses API 端点运行真实 Codex CLI
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION" 2>/dev/null || echo 'latest')"
DEFAULT_BASE_URL="http://host.docker.internal:8080/openai/v1"
DEFAULT_MODEL="gpt-5-codex"
DEFAULT_NETWORK="bridge"
IMAGE_PREFIX="kiro2claude-codex"
VOLUME_NAME="kiro2claude-codex-home"
CONTAINER_NAME="kiro2claude-codex-dev"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

usage() {
    cat <<EOF
${CYAN}kiro2claude × OpenAI Codex Docker 启动脚本${NC}

用法: $0 [选项] [-- <codex 参数...>]

选项:
  -t, --token TOKEN        API 认证 token(必填,或交互输入)→ KIRO2CLAUDE_API_KEY
  -u, --url URL            网关 OpenAI 端点(默认: $DEFAULT_BASE_URL)
  -m, --model MODEL        Codex model(默认: $DEFAULT_MODEL;保持 *codex* 名字才有工具集)
  -v, --version VERSION    Codex 版本(默认: $DEFAULT_VERSION,源: VERSION 文件)
  -n, --network NETWORK    Docker 网络: bridge | host(默认: bridge)
  -w, --workspace DIR      挂载到容器内 /workspace 的宿主机目录
      --build              强制重新构建镜像(latest 模式自动 --pull --no-cache)
      --shell              以 bash 进入容器(调试)
  -h, --help               显示帮助

  -- <args>                其后的参数原样透传给 codex(如 \`-- exec "写个 hello"\`)

示例:
  # 交互式 REPL
  $0 -t sk-local-test
  # headless 单次
  $0 -t sk-local-test -- exec "Run 'uname -s' and report output"
  # 挂载项目目录 + 交互
  $0 -t sk-local-test -w ~/projects/myapp

说明: Codex 只支持 Responses API(wire_api=responses);model 默认 gpt-5-codex——
Codex 只对它识别的模型名下发工具集,网关把它别名到 gpt-5.6-sol。
EOF
    exit 0
}

AUTH_TOKEN=""; BASE_URL=""; MODEL=""; CODEX_VERSION=""; NETWORK=""; WORKSPACE=""
FORCE_BUILD=false; SHELL_MODE=false; PASSTHROUGH=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--token)     AUTH_TOKEN="$2"; shift 2 ;;
        -u|--url)       BASE_URL="$2"; shift 2 ;;
        -m|--model)     MODEL="$2"; shift 2 ;;
        -v|--version)   CODEX_VERSION="$2"; shift 2 ;;
        -n|--network)   NETWORK="$2"; shift 2 ;;
        -w|--workspace) WORKSPACE="$2"; shift 2 ;;
        --build)        FORCE_BUILD=true; shift ;;
        --shell)        SHELL_MODE=true; shift ;;
        -h|--help)      usage ;;
        --)             shift; PASSTHROUGH=("$@"); break ;;
        *) echo -e "${RED}未知参数: $1${NC}"; usage ;;
    esac
done

prompt_input() {
    local var_name="$1" prompt="$2" default="$3" value=""
    if [[ -n "$default" ]]; then
        read -rp "$(echo -e "${CYAN}$prompt${NC} [${GREEN}$default${NC}]: ")" value
        value="${value:-$default}"
    else
        while [[ -z "$value" ]]; do
            read -rp "$(echo -e "${CYAN}$prompt${NC}: ")" value
            [[ -z "$value" ]] && echo -e "${RED}此项必填${NC}"
        done
    fi
    eval "$var_name=\"$value\""
}

[[ -z "$AUTH_TOKEN" ]] && prompt_input AUTH_TOKEN "API 认证 Token" ""
[[ -z "$BASE_URL" ]] && BASE_URL="$DEFAULT_BASE_URL"
MODEL="${MODEL:-$DEFAULT_MODEL}"
CODEX_VERSION="${CODEX_VERSION:-$DEFAULT_VERSION}"
NETWORK="${NETWORK:-$DEFAULT_NETWORK}"

OS="$(uname -s)"
IMAGE_TAG="${IMAGE_PREFIX}:${CODEX_VERSION}"

# host 网络 + 默认 URL: host.docker.internal → 127.0.0.1
if [[ "$NETWORK" == "host" && "$BASE_URL" == "$DEFAULT_BASE_URL" ]]; then
    RUNTIME_URL="${BASE_URL//host.docker.internal/127.0.0.1}"
else
    RUNTIME_URL="$BASE_URL"
fi

image_exists() { docker image inspect "$IMAGE_TAG" &>/dev/null; }

if $FORCE_BUILD || ! image_exists; then
    BUILD_ARGS=(--build-arg "CODEX_VERSION=$CODEX_VERSION" -t "$IMAGE_TAG")
    if [[ "$CODEX_VERSION" == "latest" ]]; then
        BUILD_ARGS+=(--pull --no-cache)
        echo -e "${CYAN}latest 模式:自动加 --pull --no-cache${NC}"
    fi
    echo -e "${CYAN}构建镜像 ${IMAGE_TAG} ...${NC}"
    docker build "${BUILD_ARGS[@]}" "$SCRIPT_DIR"
else
    echo -e "${GREEN}使用已有镜像 ${IMAGE_TAG}${NC}"
fi

DOCKER_ARGS=(
    run -it --rm
    --name "$CONTAINER_NAME"
    -e "KIRO2CLAUDE_API_KEY=${AUTH_TOKEN}"
    -e "KIRO2CLAUDE_BASE_URL=${RUNTIME_URL}"
    -e "CODEX_MODEL=${MODEL}"
    -v "${VOLUME_NAME}:/home/coder"
)

if [[ "$NETWORK" == "host" ]]; then
    DOCKER_ARGS+=(--network host)
elif [[ "$OS" == "Linux" ]]; then
    DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
fi

if [[ -n "$WORKSPACE" ]]; then
    ABS_WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd)" || {
        echo -e "${RED}工作目录不存在: $WORKSPACE${NC}"; exit 1; }
    DOCKER_ARGS+=(-v "${ABS_WORKSPACE}:/workspace" -w /workspace)
fi

if $SHELL_MODE; then
    DOCKER_ARGS+=(--entrypoint bash "$IMAGE_TAG")
else
    DOCKER_ARGS+=("$IMAGE_TAG" "${PASSTHROUGH[@]}")
fi

echo ""
echo -e "${CYAN}┌─────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│  kiro2claude × OpenAI Codex Docker    │${NC}"
echo -e "${CYAN}├─────────────────────────────────────────┤${NC}"
echo -e "${CYAN}│${NC}  版本:   ${GREEN}${CODEX_VERSION}${NC}"
echo -e "${CYAN}│${NC}  模型:   ${GREEN}${MODEL}${NC}  ${YELLOW}(别名→gpt-5.6-sol)${NC}"
echo -e "${CYAN}│${NC}  网关:   ${GREEN}${RUNTIME_URL}${NC}"
echo -e "${CYAN}│${NC}  Token:  ${GREEN}${AUTH_TOKEN:0:16}...${NC}"
[[ -n "$WORKSPACE" ]] && echo -e "${CYAN}│${NC}  工作区: ${GREEN}${ABS_WORKSPACE}${NC}"
echo -e "${CYAN}└─────────────────────────────────────────┘${NC}"
echo ""

exec docker "${DOCKER_ARGS[@]}"
