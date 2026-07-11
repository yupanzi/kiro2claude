#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────────
# kiro2claude × Claude Code Docker 启动脚本（闭源,开发测试用）
# 通过 kiro2claude 网关代理运行真实的 Claude Code CLI
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_VERSION="$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION" 2>/dev/null || echo 'latest')"
DEFAULT_BASE_URL="http://host.docker.internal:8080/claude"
DEFAULT_NETWORK="bridge"
IMAGE_PREFIX="kiro2claude-cc"
VOLUME_NAME="kiro2claude-cc-home"
CONTAINER_NAME="kiro2claude-cc-dev"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
    cat <<EOF
${CYAN}kiro2claude × Claude Code Docker 启动脚本${NC}

用法: $0 [选项]

选项:
  -t, --token TOKEN        API 认证 token（必填，或交互输入）
  -u, --url URL            代理网关地址（默认: $DEFAULT_BASE_URL）
  -v, --version VERSION    Claude Code 版本（默认: $DEFAULT_VERSION，源: VERSION 文件，可用 'latest'）
  -n, --network NETWORK    Docker 网络模式: bridge | host（默认: bridge）
  -w, --workspace DIR      挂载到容器内 /workspace 的宿主机目录
      --build              强制重新构建镜像（latest 模式自动 --pull --no-cache）
      --shell              以 bash 进入容器（调试用）
  -h, --help               显示帮助

示例:
  # 交互式输入 token
  $0

  # 指定参数启动（默认 latest）
  $0 -t cc-admin-kiro-xxx -w ~/projects/myapp

  # 使用 host 网络（Linux 推荐）
  $0 -t cc-admin-kiro-xxx -n host

  # 锁定特定 Claude Code 版本（X.Y.Z 替换为实际 semver,例如 npm view @anthropic-ai/claude-code version 查到的值）
  $0 -t cc-admin-kiro-xxx -v X.Y.Z --build
EOF
    exit 0
}

# ── Parse arguments ──────────────────────────────────────────

AUTH_TOKEN=""
BASE_URL=""
CC_VERSION=""
NETWORK=""
WORKSPACE=""
FORCE_BUILD=false
SHELL_MODE=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--token)    AUTH_TOKEN="$2"; shift 2 ;;
        -u|--url)      BASE_URL="$2"; shift 2 ;;
        -v|--version)  CC_VERSION="$2"; shift 2 ;;
        -n|--network)  NETWORK="$2"; shift 2 ;;
        -w|--workspace) WORKSPACE="$2"; shift 2 ;;
        --build)       FORCE_BUILD=true; shift ;;
        --shell)       SHELL_MODE=true; shift ;;
        -h|--help)     usage ;;
        *) echo -e "${RED}未知参数: $1${NC}"; usage ;;
    esac
done

# ── Interactive prompts for missing values ───────────────────

prompt_input() {
    local var_name="$1" prompt="$2" default="$3"
    local value=""
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

if [[ -z "$AUTH_TOKEN" ]]; then
    prompt_input AUTH_TOKEN "API 认证 Token" ""
fi

if [[ -z "$BASE_URL" ]]; then
    prompt_input BASE_URL "代理网关地址" "$DEFAULT_BASE_URL"
fi

CC_VERSION="${CC_VERSION:-$DEFAULT_VERSION}"

if [[ -z "$NETWORK" ]]; then
    prompt_input NETWORK "Docker 网络模式 (bridge/host)" "$DEFAULT_NETWORK"
fi

# ── Detect OS for host networking ────────────────────────────

OS="$(uname -s)"
IMAGE_TAG="${IMAGE_PREFIX}:${CC_VERSION}"

# Adjust BASE_URL for network mode
if [[ "$NETWORK" == "host" && "$BASE_URL" == "$DEFAULT_BASE_URL" ]]; then
    # host 模式 + 使用默认 URL：替换 host.docker.internal 为 127.0.0.1
    RUNTIME_URL="${BASE_URL//host.docker.internal/127.0.0.1}"
    echo -e "${YELLOW}host 网络模式（默认 URL）：已将地址调整为 ${RUNTIME_URL}${NC}"
elif [[ "$NETWORK" == "host" ]]; then
    # host 模式 + 用户自定义 URL：保持不变
    RUNTIME_URL="$BASE_URL"
    echo -e "${YELLOW}host 网络模式：使用自定义地址 ${RUNTIME_URL}${NC}"
else
    RUNTIME_URL="$BASE_URL"
fi

# ── Build image if needed ────────────────────────────────────

image_exists() {
    docker image inspect "$IMAGE_TAG" &>/dev/null
}

if $FORCE_BUILD || ! image_exists; then
    BUILD_ARGS=(--build-arg "CLAUDE_CODE_VERSION=$CC_VERSION" -t "$IMAGE_TAG")
    # latest 模式下 build-arg 字符串不变,docker 会命中 layer cache,实际不会重拉新 npm 包
    # 必须 --pull --no-cache 强制重建 RUN 层
    if [[ "$CC_VERSION" == "latest" ]]; then
        BUILD_ARGS+=(--pull --no-cache)
        echo -e "${CYAN}latest 模式：自动加 --pull --no-cache 强制拉新${NC}"
    fi
    echo -e "${CYAN}构建镜像 ${IMAGE_TAG} ...${NC}"
    docker build "${BUILD_ARGS[@]}" "$SCRIPT_DIR"
    echo -e "${GREEN}镜像构建完成${NC}"
else
    echo -e "${GREEN}使用已有镜像 ${IMAGE_TAG}${NC}"
fi

# 只在 latest 模式才需要跑 docker 读 /etc/cc-version——pinned 模式下请求即实际
if [[ "$CC_VERSION" == "latest" ]]; then
    RESOLVED_VERSION="$(docker run --rm --entrypoint cat "$IMAGE_TAG" /etc/cc-version 2>/dev/null || echo 'unknown')"
else
    RESOLVED_VERSION="$CC_VERSION"
fi

# ── Compose docker run args ──────────────────────────────────

DOCKER_ARGS=(
    run -it --rm
    --name "$CONTAINER_NAME"
    -e "ANTHROPIC_AUTH_TOKEN=${AUTH_TOKEN}"
    -e "ANTHROPIC_BASE_URL=${RUNTIME_URL}"
    -v "${VOLUME_NAME}:/home/claude"
)

# Network
if [[ "$NETWORK" == "host" ]]; then
    DOCKER_ARGS+=(--network host)
else
    # bridge 模式需要 host.docker.internal 解析宿主机
    if [[ "$OS" == "Linux" ]]; then
        DOCKER_ARGS+=(--add-host=host.docker.internal:host-gateway)
    fi
    # macOS Docker Desktop 自动支持 host.docker.internal
fi

# Workspace mount
if [[ -n "$WORKSPACE" ]]; then
    ABS_WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd)" || {
        echo -e "${RED}工作目录不存在: $WORKSPACE${NC}"
        exit 1
    }
    DOCKER_ARGS+=(-v "${ABS_WORKSPACE}:/workspace" -w /workspace)
fi

# Shell mode
if $SHELL_MODE; then
    DOCKER_ARGS+=(--entrypoint bash "$IMAGE_TAG")
else
    DOCKER_ARGS+=("$IMAGE_TAG")
fi

# ── Print summary and launch ─────────────────────────────────

echo ""
echo -e "${CYAN}┌─────────────────────────────────────────┐${NC}"
echo -e "${CYAN}│  kiro2claude × Claude Code Docker     │${NC}"
echo -e "${CYAN}├─────────────────────────────────────────┤${NC}"
if [[ "$CC_VERSION" != "$RESOLVED_VERSION" ]]; then
    echo -e "${CYAN}│${NC}  请求版本: ${GREEN}${CC_VERSION}${NC}"
    echo -e "${CYAN}│${NC}  实际版本: ${GREEN}${RESOLVED_VERSION}${NC}"
else
    echo -e "${CYAN}│${NC}  版本:     ${GREEN}${CC_VERSION}${NC}"
fi
echo -e "${CYAN}│${NC}  网络:     ${GREEN}${NETWORK}${NC}"
echo -e "${CYAN}│${NC}  网关:     ${GREEN}${RUNTIME_URL}${NC}"
echo -e "${CYAN}│${NC}  Token:    ${GREEN}${AUTH_TOKEN:0:20}...${NC}"
[[ -n "$WORKSPACE" ]] && echo -e "${CYAN}│${NC}  工作目录: ${GREEN}${ABS_WORKSPACE}${NC}"
echo -e "${CYAN}│${NC}  持久卷:   ${GREEN}${VOLUME_NAME}${NC}"
echo -e "${CYAN}└─────────────────────────────────────────┘${NC}"
echo ""

exec docker "${DOCKER_ARGS[@]}"
