#!/usr/bin/env bash
#
# docker-build.sh —— 自动从 fixtures/kiro-cli-profile.json 派生 kiro-cli 版本号
# 后调用 `docker build`，让镜像永远和当前 committed 的 client profile 同源。
#
# 为什么需要 wrapper：Dockerfile 的 `ARG VAR=default` 默认值必须是字面量，
# 不能写成 `ARG VAR=$(cat fixture.json)`。所以让 docker build "自动同步" 的
# 唯一办法是在 build 之前读 fixture 然后传 `--build-arg`。
#
# 用法：
#   ./scripts/docker-build.sh                                  # 默认 build,无 tag
#   ./scripts/docker-build.sh -t kiro2claude              # 自动追加 :2.5.0
#   ./scripts/docker-build.sh -t kiro2claude:dev          # 自动追加 kiro2claude:2.5.0
#   ./scripts/docker-build.sh --no-version-tag -t image        # 关掉自动 version tag
#   ./scripts/docker-build.sh --no-cache -t kiro2claude   # 透传 docker build 任意参数
#   pnpm docker:build -- -t kiro2claude                   # 通过 pnpm 跑(注意 -- 分隔符)
#
# 自动 version tag 行为（默认开启）：
#   每个 -t / --tag 参数指向的 image,wrapper 会额外追加一个 -t IMAGE:${VERSION}。
#   例如 `-t kiro2claude` 实际跑 `-t kiro2claude -t kiro2claude:2.5.0`，
#   镜像同时具有 :latest（默认 tag）和 :2.5.0 两个引用。设 --no-version-tag 关闭。
#
# Exit code：透传 docker build 的退出码（exec docker build）。

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FIXTURE="$PROJECT_ROOT/fixtures/kiro-cli-profile.json"

if [[ ! -f "$FIXTURE" ]]; then
  echo "错误: 找不到 fixture $FIXTURE" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node（用于解析 fixture JSON）" >&2
  exit 1
fi

VERSION="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const o=JSON.parse(fs.readFileSync(p,"utf-8")); process.stdout.write(o.kiroCliVersion || "")' "$FIXTURE")"

if [[ -z "$VERSION" ]]; then
  echo "错误: $FIXTURE 缺少 kiroCliVersion 字段" >&2
  exit 1
fi
if [[ "$VERSION" == "unknown" ]]; then
  echo "错误: fixture 的 kiroCliVersion 是 'unknown'。请先跑 ./scripts/capture-kiro-cli.sh 抓取真实版本" >&2
  exit 1
fi

# 处理 pnpm run docker:build -- ... 的 `--` 分隔符：
# pnpm 把 `--` 透传给脚本（位置参数 $1），但 docker build 不接受 `--`
# 作为 end-of-options 标记。这里 strip 掉首个 `--` 让传参语义统一。
if [[ "${1:-}" == "--" ]]; then
  shift
fi

# ----------------------------------------------------------------------------
# 解析参数：抽 -t / --tag 后的 image refs，过滤 --no-version-tag 选项
# ----------------------------------------------------------------------------
ADD_VERSION_TAG=true
declare -a PASSTHRU_ARGS=()
declare -a IMAGE_REFS=()
EXPECT_TAG_VALUE=false

for arg in "$@"; do
  if [[ "$EXPECT_TAG_VALUE" == "true" ]]; then
    # 上一个参数是 -t / --tag，这个就是 image ref
    IMAGE_REFS+=("$arg")
    PASSTHRU_ARGS+=("$arg")
    EXPECT_TAG_VALUE=false
    continue
  fi
  case "$arg" in
    --no-version-tag)
      # 仅 wrapper 自己消费，不透传给 docker build
      ADD_VERSION_TAG=false
      ;;
    -t|--tag)
      EXPECT_TAG_VALUE=true
      PASSTHRU_ARGS+=("$arg")
      ;;
    -t=*)
      IMAGE_REFS+=("${arg#-t=}")
      PASSTHRU_ARGS+=("$arg")
      ;;
    --tag=*)
      IMAGE_REFS+=("${arg#--tag=}")
      PASSTHRU_ARGS+=("$arg")
      ;;
    *)
      PASSTHRU_ARGS+=("$arg")
      ;;
  esac
done

# ----------------------------------------------------------------------------
# 为每个 image ref 计算 :${VERSION} 副本
# ----------------------------------------------------------------------------
# image ref 形态识别（按最后一段是否含 `:` 判断有无显式 tag）：
#   image                          → base=image,           tagged=image:VERSION
#   image:latest                   → base=image,           tagged=image:VERSION
#   registry:5000/image            → base=registry:5000/image, tagged=image:VERSION (无 :tag)
#   registry:5000/image:dev        → base=registry:5000/image, tagged=image:VERSION
declare -a EXTRA_TAG_ARGS=()
if [[ "$ADD_VERSION_TAG" == "true" ]]; then
  for ref in "${IMAGE_REFS[@]}"; do
    last_segment="${ref##*/}"
    if [[ "$last_segment" == *:* ]]; then
      # 最后一段含 : ——切掉 :tag 得到 base
      base="${ref%:*}"
    else
      # 最后一段无 : ——整个 ref 就是 base
      base="$ref"
    fi
    EXTRA_TAG_ARGS+=("-t" "${base}:${VERSION}")
  done
fi

# ----------------------------------------------------------------------------
# 最终命令
# ----------------------------------------------------------------------------
echo "→ 从 $FIXTURE 派生 kiro-cli 版本: $VERSION"
if [[ ${#EXTRA_TAG_ARGS[@]} -gt 0 ]]; then
  echo "→ 自动追加版本号 tag: ${EXTRA_TAG_ARGS[*]}"
fi
echo "→ exec docker build --build-arg KIRO2CLAUDE_CLI_VERSION=$VERSION ${PASSTHRU_ARGS[*]:-} ${EXTRA_TAG_ARGS[*]:-} ."
cd "$PROJECT_ROOT"
exec docker build \
  --build-arg "KIRO2CLAUDE_CLI_VERSION=$VERSION" \
  ${PASSTHRU_ARGS[@]+"${PASSTHRU_ARGS[@]}"} \
  ${EXTRA_TAG_ARGS[@]+"${EXTRA_TAG_ARGS[@]}"} \
  .
