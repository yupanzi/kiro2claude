#!/usr/bin/env bash
#
# docker-run.sh —— 一键启动 kiro2claude Docker 容器，帮你记住上次的参数。
#
# 三种用法（由简到繁）：
#
# 用法 1：在 .env.docker 里写一次默认值，之后零参数启动
# ------------------------------------------------------------
#   cat > .env.docker <<EOF
#   API_KEY=sk-local-change-me
#   START_URL=https://d-xxxxxxxxxx.awsapps.com/start
#   REGION=us-east-1
#   PORT=8080
#   EOF
#   ./scripts/docker-run.sh
#
# （.env.docker 被 .gitignore 的 `.env.*` 规则自动忽略，不会进 git。）
#
# 用法 2：命令行覆盖单个参数
# ------------------------------------------------------------
#   ./scripts/docker-run.sh --port 18080
#   ./scripts/docker-run.sh --api-key sk-test-xxx --rebuild
#
# 用法 3：首次使用，全部通过 CLI 传入
# ------------------------------------------------------------
#   ./scripts/docker-run.sh \
#     --api-key sk-local-change-me \
#     --start-url https://d-xxxxxxxxxx.awsapps.com/start
#
# 支持的选项（都可省略走默认值）：
#
#   --api-key KEY      下游 Claude 客户端鉴权 key（必需，也可 env KIRO2CLAUDE_API_KEY）
#   --start-url URL    IdC start URL；留空则跳过 bootstrap login
#                      （适合你已经有认证好的 kiro-home 卷的场景）
#   --region REGION    IdC region，默认 us-east-1
#   --port PORT        宿主端口（映射到容器 8080），默认 8080
#   --name NAME        容器名，默认 kiro2claude
#   --image IMAGE      镜像 tag，默认 kiro2claude:latest
#   --volume VOL       持久化卷名，默认 kiro-home
#                      （删掉卷 = 清除认证 = 下次重新走 device flow）
#   --rebuild          启动前先 docker build -t $IMAGE .
#   --logs             启动后立刻 docker logs -f（首次登录用来看 device flow URL）
#   --recreate         同名容器存在时先删再建（默认：已存在就报错退出）
#   -h, --help         显示本帮助
#
# 第一次启动时：浏览器打开日志里的 `Open this URL: ...` 链接完成 IdC 认证。
# 之后重启（只要 --volume 对应的卷还在）就完全跳过认证，15 秒内起服务。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# 默认值 —— 优先级：CLI flag > 环境变量 > .env.docker > 硬编码
# ---------------------------------------------------------------------------
API_KEY="${KIRO2CLAUDE_API_KEY:-}"
START_URL="${KIRO2CLAUDE_LOGIN_START_URL:-}"
REGION="${KIRO2CLAUDE_LOGIN_REGION:-us-east-1}"
PORT="${KIRO2CLAUDE_PORT_HOST:-8080}"
NAME="${KIRO2CLAUDE_CONTAINER_NAME:-kiro2claude}"
IMAGE="${KIRO2CLAUDE_IMAGE:-kiro2claude:latest}"
VOLUME="${KIRO2CLAUDE_VOLUME:-kiro-home}"
REBUILD=0
FOLLOW_LOGS=0
RECREATE=0

# 如果项目根有 .env.docker，source 进来作为额外默认值。
# 约定的变量名（不带 KIRO2CLAUDE_ 前缀，避免和 Node 端的配置变量混淆）：
#   API_KEY / START_URL / REGION / PORT / NAME / IMAGE / VOLUME
if [[ -f "$PROJECT_ROOT/.env.docker" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$PROJECT_ROOT/.env.docker"; set +a
fi

# ---------------------------------------------------------------------------
# 解析 CLI 参数 —— 覆盖上面的任何默认值
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-key)    API_KEY="$2";     shift 2 ;;
    --start-url)  START_URL="$2";   shift 2 ;;
    --region)     REGION="$2";      shift 2 ;;
    --port)       PORT="$2";        shift 2 ;;
    --name)       NAME="$2";        shift 2 ;;
    --image)      IMAGE="$2";       shift 2 ;;
    --volume)     VOLUME="$2";      shift 2 ;;
    --rebuild)    REBUILD=1;        shift ;;
    --logs)       FOLLOW_LOGS=1;    shift ;;
    --recreate)   RECREATE=1;       shift ;;
    -h|--help)
      # 打印脚本头部的注释作为帮助文本（从第 2 行到第一个空注释行）
      sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "错误: 未知参数 '$1'。用 --help 查看用法。" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 校验必需项
# ---------------------------------------------------------------------------
if [[ -z "$API_KEY" ]]; then
  cat >&2 <<EOF
错误: 缺少 API_KEY。通过以下任意方式提供：
  1) CLI flag:  --api-key sk-xxx
  2) 环境变量:  KIRO2CLAUDE_API_KEY=sk-xxx $0
  3) 写入文件:  echo 'API_KEY=sk-xxx' >> .env.docker
EOF
  exit 1
fi

if [[ -z "$START_URL" ]]; then
  echo "警告: 未设置 START_URL（--start-url 或 .env.docker 里的 START_URL）" >&2
  echo "       如果 $VOLUME 卷已经有认证状态，这是 OK 的；否则首次启动会失败。" >&2
fi

# ---------------------------------------------------------------------------
# 准备镜像
# ---------------------------------------------------------------------------
if [[ "$REBUILD" -eq 1 ]]; then
  echo "→ docker build -t $IMAGE $PROJECT_ROOT"
  docker build -t "$IMAGE" "$PROJECT_ROOT"
elif ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  cat >&2 <<EOF
错误: 镜像 '$IMAGE' 不存在。
  先跑:  $0 --rebuild $*
  或者:  docker build -t $IMAGE $PROJECT_ROOT
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# 处理同名容器
# ---------------------------------------------------------------------------
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  STATUS=$(docker inspect -f '{{.State.Status}}' "$NAME" 2>/dev/null || echo "unknown")
  if [[ "$RECREATE" -eq 1 ]]; then
    echo "→ 已存在容器 $NAME (status=$STATUS)，--recreate 删除后重建"
    docker rm -f "$NAME" >/dev/null
  else
    cat >&2 <<EOF
错误: 容器 '$NAME' 已存在 (status=$STATUS)。
  用 --recreate 先删再建；或者手动:
    docker rm -f $NAME
    docker logs -f $NAME       # 看日志
    docker restart $NAME       # 重启 (保留卷，无需重新认证)
EOF
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 检测卷的持久化状态 —— 让用户知道"这次启动会不会再弹 device flow"
# ---------------------------------------------------------------------------
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "→ 卷 '$VOLUME' 已存在 —— 预期：bootstrap 跳过登录，直接起服务 (~15s)"
else
  echo "→ 卷 '$VOLUME' 不存在 —— 预期：首次启动，需要浏览器完成 device flow 认证"
fi

# ---------------------------------------------------------------------------
# 构造并运行 docker run
# ---------------------------------------------------------------------------
ENV_ARGS=(
  -e "KIRO2CLAUDE_API_KEY=$API_KEY"
  -e "KIRO2CLAUDE_HOST=0.0.0.0"
  -e "KIRO2CLAUDE_LOGIN_REGION=$REGION"
)
if [[ -n "$START_URL" ]]; then
  ENV_ARGS+=(-e "KIRO2CLAUDE_LOGIN_START_URL=$START_URL")
fi

echo "→ docker run $NAME  image=$IMAGE  port=$PORT→8080  volume=$VOLUME"
CID=$(docker run -d \
  --name "$NAME" \
  "${ENV_ARGS[@]}" \
  -p "${PORT}:8080" \
  -v "${VOLUME}:/home/kiro/.local/share/kiro-cli" \
  "$IMAGE")
echo "✓ 容器已启动: ${CID:0:12}"

# ---------------------------------------------------------------------------
# 下一步提示
# ---------------------------------------------------------------------------
cat <<EOF

━━━ 下一步命令速查 ━━━
  跟随日志:        docker logs -f $NAME
  首次登录找 URL:  docker logs -f $NAME 2>&1 | grep --line-buffered -E 'Open this URL|Code:'
  停止:            docker stop $NAME
  重启 (免认证):   docker restart $NAME
  进容器排错:      docker exec -it $NAME /bin/sh
  清理容器:        docker rm -f $NAME
  清理卷 (登出):   docker volume rm $VOLUME
  smoke 测试:      curl -H "x-api-key: $API_KEY" http://localhost:$PORT/claude/v1/models
EOF

if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
  echo
  echo "→ 跟随日志 (Ctrl+C 退出，容器仍在后台运行)..."
  exec docker logs -f "$NAME"
fi
