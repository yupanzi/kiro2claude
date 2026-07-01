# syntax=docker/dockerfile:1.7
# ============================================================================
# 构建约定
# ----------------------------------------------------------------------------
# - 本 Dockerfile 只针对 linux/amd64：官方 kiro-cli 有 arm64 发行版，但
#   我们当前只锁定一个架构，避免多架构 manifest 的复杂度。如果要切换到
#   arm64，把 KIRO2CLAUDE_CLI_ARCHIVE 和 FROM 里的 --platform 一起改掉就好。
# - kiro-cli 版本的「唯一真相源」是 fixtures/kiro-cli-profile.json 的
#   kiroCliVersion 字段。`ARG KIRO2CLAUDE_CLI_VERSION` 故意**没有**默认值——
#   build 时必须由外部提供，确保版本号永远派生自 fixture，不可能漂移。
# - 推荐入口：`pnpm docker:build`（或 `./scripts/docker-build.sh`），它会
#   读 fixture 然后自动 `docker build --build-arg KIRO2CLAUDE_CLI_VERSION=<X>`。
# - 直接跑 `docker build .` 会失败：URL 模板里的 ${KIRO2CLAUDE_CLI_VERSION}
#   会变成空字符串，curl 拉 stable//kirocli-... 拿到 403。错误信息会提示
#   改用 wrapper。这是 feature，不是 bug——强制走单一真相源。
# - 下载 URL 是版本化的（`stable/${KIRO2CLAUDE_CLI_VERSION}/`），CDN 实测
#   支持任意已发布版本。所以 build 永久锁定指定版本，上游 latest 升级也
#   不会影响已有 build。fetcher 末尾的 `--version` 校验是"完整性兜底"——
#   防 CDN 给错文件。
# - 升级 kiro-cli 的流程：
#     1) 本机升级 kiro-cli
#     2) ./scripts/capture-kiro-cli.sh    （只更新 fixture，无副作用）
#     3) pnpm docker:build                 （自动用新版本 build）
#     4) git add fixtures/ && git commit
# ============================================================================
ARG KIRO2CLAUDE_CLI_VERSION
ARG KIRO2CLAUDE_CLI_ARCHIVE=kirocli-x86_64-linux.zip
ARG KIRO2CLAUDE_CLI_URL=https://prod.download.cli.kiro.dev/stable/${KIRO2CLAUDE_CLI_VERSION}/${KIRO2CLAUDE_CLI_ARCHIVE}


# ============================================================================
# Stage 1: kiro-cli fetcher
# ----------------------------------------------------------------------------
# 单独一个 stage 下载并校验 kiro-cli，与 Node 编译阶段解耦：
# - 下载失败不会污染 node_modules 缓存层
# - 校验逻辑集中在这里，后续 stage 只需要 COPY 过去就行
# - 版本校验失败时 RUN 指令立即退出，错误信息直接体现在 docker build 输出里
# ============================================================================
FROM --platform=linux/amd64 debian:bookworm-slim AS kiro-cli-fetcher

ARG KIRO2CLAUDE_CLI_VERSION
ARG KIRO2CLAUDE_CLI_ARCHIVE
ARG KIRO2CLAUDE_CLI_URL

# 早期校验：KIRO2CLAUDE_CLI_VERSION 必须非空。如果为空，URL 会变成
# `stable//kirocli-...`，curl 拿到 403 但错误信息不直观——这里 fail-fast
# 给出明确指引，让用户立刻知道走 wrapper 而不是猜 403 的来源。
RUN if [ -z "${KIRO2CLAUDE_CLI_VERSION}" ]; then \
      echo "" >&2; \
      echo "ERROR: ARG KIRO2CLAUDE_CLI_VERSION 未设置或为空。" >&2; \
      echo "" >&2; \
      echo "本项目以 fixtures/kiro-cli-profile.json 的 kiroCliVersion 字段为唯一真相源，" >&2; \
      echo "Dockerfile ARG 不再保留 hardcoded 默认值。请用 wrapper 入口：" >&2; \
      echo "" >&2; \
      echo "  pnpm docker:build -- -t kiro2claude            # 推荐" >&2; \
      echo "  ./scripts/docker-build.sh -t kiro2claude       # 等价" >&2; \
      echo "" >&2; \
      echo "或显式传 --build-arg（不推荐，要自己保证和 fixture 一致）：" >&2; \
      echo "" >&2; \
      echo "  docker build --build-arg KIRO2CLAUDE_CLI_VERSION=<X> -t kiro2claude ." >&2; \
      echo "" >&2; \
      exit 1; \
    fi

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/kiro-cli-src

# 下载 + 解压 + 本地安装到 /opt/kiro-cli。
# - zip 解压后会得到一个名为 `kirocli/` 的目录（官方分发约定）
# - install.sh 默认会把二进制写到 $HOME/.local/bin，这里把 HOME 指向
#   /opt/kiro-cli 让所有产物落在一个干净的前缀下，方便后续 stage COPY
# - 用 bash 显式执行 install.sh：Arm learn 官方指南也是这么写的，避免
#   某些 slim 镜像里 /bin/sh 是 dash 而脚本里有 bashism
# - `--force`：install.sh 拒绝 root 安装（kiro-cli 1.29.7+ 行为），退出码
#   为 1 并打印 "Installing as root is not supported"，即使 --force 也一样
#   退出 1（但二进制本身已经被正确写入 .local/bin）。我们就是在一次性
#   build 环境里，用 `|| true` 吃掉这个非零退出，再显式断言
#   /opt/kiro-cli/.local/bin/kiro-cli 存在且可执行作为真正的成败判据
RUN set -eux; \
    curl --proto '=https' --tlsv1.2 -fsSL -o kiro-cli.zip "${KIRO2CLAUDE_CLI_URL}"; \
    unzip -q kiro-cli.zip; \
    test -f ./kirocli/install.sh || { echo "ERROR: 解压后没找到 kirocli/install.sh，zip 布局可能变了" >&2; ls -la; exit 1; }; \
    mkdir -p /opt/kiro-cli; \
    HOME=/opt/kiro-cli bash ./kirocli/install.sh --no-confirm --force || true; \
    test -x /opt/kiro-cli/.local/bin/kiro-cli || { echo "ERROR: install.sh 跑完了但 /opt/kiro-cli/.local/bin/kiro-cli 不存在或不可执行" >&2; exit 1; }; \
    ls -la /opt/kiro-cli/.local/bin; \
    rm -rf /opt/kiro-cli-src

# 装主 kiro-cli 二进制 + kiro-cli-chat helper 到
# /out/usr/local/bin，后续 stage 用一条 COPY --from 就能搬走。
#
# 二进制清单（来自 install.sh 在 /opt/kiro-cli/.local/bin/ 下的输出）：
#   - kiro-cli      ~117MB  主二进制（login/whoami/profile/--version 等入口）
#   - kiro-cli-chat ~300MB  `kiro-cli chat` 会 spawn 同目录下的 kiro-cli-chat 作为
#                            helper；默认 HTTP 直发不调用它，opt-in 的 auto-capture
#                            （KIRO2CLAUDE_AUTO_CAPTURE_PROFILE）实时抓 profile 时会
#                            用到，缺它则回落到仓库里的 baked fixture
#   - kiro-cli-term ~200MB  本项目无任何代码路径调 `kiro-cli term`，省掉
#
# 镜像大小：t3.nano (512MiB) 上装全部二进制会 OOM；现机型 t3.micro (1 GiB)，
# ~450MB 镜像（主二进制 + kiro-cli-chat）docker pull 不会 OOM。
#
# 防御：如果 install.sh 在新版 kiro-cli 中改了二进制路径或名字，
# `test -x` 断言会让 build 立即失败，而不是部署后 crash-loop。
#
# 注意：避免在 RUN `\` 续行块里穿插 Dockerfile `#` 注释——parser 的处理
# 行为在不同版本下不完全一致，踩过一次坑。
RUN set -eux; \
    test -x /opt/kiro-cli/.local/bin/kiro-cli-chat || { echo "ERROR: 缺少 /opt/kiro-cli/.local/bin/kiro-cli-chat。install.sh 输出布局可能在新版本中改变，请检查上一步 ls -la /opt/kiro-cli/.local/bin 的输出" >&2; exit 1; }; \
    install -Dm755 /opt/kiro-cli/.local/bin/kiro-cli      /out/usr/local/bin/kiro-cli; \
    install -Dm755 /opt/kiro-cli/.local/bin/kiro-cli-chat /out/usr/local/bin/kiro-cli-chat; \
    ls -la /out/usr/local/bin

# 运行 --version 校验：必须和 ARG KIRO2CLAUDE_CLI_VERSION 逐字节一致。
# kiro-cli --version 的典型输出是 `kiro-cli 2.0.1`，取最后一个 token。
RUN set -eux; \
    installed="$(/out/usr/local/bin/kiro-cli --version 2>&1 | awk '{print $NF}')"; \
    expected="${KIRO2CLAUDE_CLI_VERSION}"; \
    echo "kiro-cli installed version : ${installed}"; \
    echo "kiro-cli expected version  : ${expected}"; \
    if [ "${installed}" != "${expected}" ]; then \
      echo "ERROR: kiro-cli 版本漂移。上游 latest 是 ${installed}，Dockerfile 期望 ${expected}。" >&2; \
      echo "修复步骤：" >&2; \
      echo "  1) 升级本机 kiro-cli 到 ${installed}" >&2; \
      echo "  2) 重新跑 ./scripts/capture-kiro-cli.sh 更新 fixtures/kiro-cli-profile.json" >&2; \
      echo "  3) 在 docker build 时传 --build-arg KIRO2CLAUDE_CLI_VERSION=${installed}" >&2; \
      echo "     或者直接把 Dockerfile 顶部的 ARG KIRO2CLAUDE_CLI_VERSION 默认值改成 ${installed}" >&2; \
      exit 1; \
    fi


# ============================================================================
# Stage 2: Backend Builder
# ----------------------------------------------------------------------------
# 安装编译工具链编译 better-sqlite3 原生模块，安装依赖并编译 TypeScript。
# 顺便校验 fixtures/kiro-cli-profile.json 的 kiroCliVersion 与 ARG 一致。
# ============================================================================
FROM --platform=linux/amd64 node:22-bookworm-slim AS builder

ARG KIRO2CLAUDE_CLI_VERSION

WORKDIR /build

# better-sqlite3 是原生模块，需要 python3 + g++ + make 来编译
# 完成后清理 apt 缓存以减小镜像层大小
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 安装 pnpm（Node 22 镜像自带 npm；锁定与 package.json `packageManager` 同版本
# 保证 lockfile 稳定，不依赖 corepack 签名校验的各种开关）
RUN npm install -g pnpm@10.33.2

# Monorepo workspace 布局:仓根是 workspace root,真正的 core 代码
# 在 packages/core/。Docker build context 必须含 pnpm-workspace.yaml 与 packages/,
# 否则 pnpm install 无法解析 workspace:* 协议依赖。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages

# `--filter @kiro2claude/core...` 安装 core 包及其传递依赖(含 workspace:* 的 plugin-api)。
# `--frozen-lockfile` 锁定到 pnpm-lock.yaml,build 永远 reproducible。
RUN pnpm install --frozen-lockfile --filter '@kiro2claude/core...'

# 编译 plugin-api(被 core 引用)+ core(输出落到 packages/core/dist/)。
# `...` 后缀让 pnpm 拓扑排序:plugin-api 先 build,core 后 build。
RUN pnpm --filter '@kiro2claude/core...' run build

# ---------------------------------------------------------------------------
# 校验 fixture 与 ARG KIRO2CLAUDE_CLI_VERSION 一致
# ---------------------------------------------------------------------------
# 把 fixture 复制到 builder，用 node 解析 JSON 比较字段值。这里故意不依
# 赖 jq 之类的额外工具，node 本身就在 builder stage 里了。
COPY fixtures ./fixtures
RUN set -eux; \
    fixture_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("fixtures/kiro-cli-profile.json","utf-8")).kiroCliVersion || "")')"; \
    expected="${KIRO2CLAUDE_CLI_VERSION}"; \
    echo "fixture kiroCliVersion : ${fixture_version}"; \
    echo "expected (ARG)         : ${expected}"; \
    if [ "${fixture_version}" != "${expected}" ]; then \
      echo "ERROR: fixtures/kiro-cli-profile.json 的 kiroCliVersion (${fixture_version}) 与 ARG KIRO2CLAUDE_CLI_VERSION (${expected}) 不一致。" >&2; \
      echo "请重新跑 ./scripts/capture-kiro-cli.sh 抓取与目标 kiro-cli 版本匹配的 fixture。" >&2; \
      exit 1; \
    fi

# 用 pnpm deploy 把 core 包 + production deps 导出到 /deploy(self-contained app):
#   /deploy/package.json   = packages/core/package.json(workspace:* 已 replace 成具体版本)
#   /deploy/dist/          = packages/core/dist/(已编译产物)
#   /deploy/node_modules/  = 扁平 prod deps(plugin-api 物化成普通包,无 symlink)
# `--legacy` 让 node_modules 是 flatten 风格(非 isolated symlink),Docker COPY 友好。
# `--prod` 跳过 devDependencies(tsc 等编译工具不进 runtime)。
RUN pnpm --filter '@kiro2claude/core' deploy --prod --legacy /deploy


# ============================================================================
# Stage 3: Runtime
# ----------------------------------------------------------------------------
# 仅包含运行所需的 node_modules + 编译产物 + kiro-cli 二进制 + fixture。
# 不带任何编译工具链。
# ============================================================================
FROM --platform=linux/amd64 node:22-bookworm-slim AS runtime

ARG KIRO2CLAUDE_CLI_VERSION

# 安装运行时必需的系统库 (libstdc++ 已在 slim 镜像中)
# tini 用于优雅处理信号
# 安装 curl 用于 HEALTHCHECK（slim 镜像不自带）
#
# Chromium / Electron-style runtime libs(libasound2 + 一组 X11/font/gtk so):
# kiro-cli-chat 内置 chromium-style runtime, 会 dlopen 一票 .so(详见 fetcher
# stage 注释)。这些库 slim 镜像默认不装, 缺 libasound.so.2 等会让 kiro-cli-chat
# 启动期立即 exit 127, 显式列出避免遗漏。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini ca-certificates curl \
      libasound2 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdbus-1-3 \
      libxkbcommon0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libpango-1.0-0 libcairo2 \
      libdrm2 libexpat1 libnspr4 fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户
RUN groupadd --system --gid 1001 kiro \
 && useradd --system --uid 1001 --gid kiro --shell /bin/false --create-home kiro

# 应用代码目录
WORKDIR /app

# 从 builder 阶段复制 pnpm deploy 导出的 self-contained app(/deploy)+ 已校验的 fixture
# (fixture 还在 /build,deploy 不包含 fixtures)
COPY --from=builder --chown=kiro:kiro /deploy/dist ./dist
COPY --from=builder --chown=kiro:kiro /deploy/node_modules ./node_modules
COPY --from=builder --chown=kiro:kiro /deploy/package.json ./package.json
COPY --from=builder --chown=kiro:kiro /build/fixtures ./fixtures
# capture-kiro-cli.sh 在启动期由 auto-capture 调用，必须打进 runtime 镜像。
# auto-capture.ts 的 findCaptureScript() 按 `/app/scripts/` 查找，布局要和
# src/ 开发模式（仓库根的 scripts/）对齐
COPY --chown=kiro:kiro scripts ./scripts

# 从 fetcher 阶段复制 kiro-cli 二进制到 /usr/local/bin，容器内 auto-capture
# 就能直接 spawn。权限由 install -Dm755 保证。
COPY --from=kiro-cli-fetcher /out/usr/local/bin/ /usr/local/bin/

# 数据目录：
#   - /data：通用工作目录，供用户按需挂载（例如放日志、导出文件等）
#   - /home/kiro/.local/share/kiro-cli：kiro-cli 在 Linux 下的标准 SQLite DB
#     位置（device code flow 凭据 + bootstrap-login 使用）。提前以 kiro
#     用户身份建好整条目录链，用户只挂载一个命名卷到这里即可持久化
RUN mkdir -p /data /home/kiro/.local/share/kiro-cli \
 && chown -R kiro:kiro /data /home/kiro/.local

USER kiro
WORKDIR /data

# 默认端口（可通过 KIRO2CLAUDE_PORT 环境变量覆盖）
EXPOSE 8080

# 默认：
#   - 容器内 auto-capture 关闭。镜像里已经装了 kiro-cli + kiro-cli-chat,
#     scripts/capture-kiro-cli.sh 能正常 spawn `kiro-cli chat`,所以从二进制
#     可用性角度可以打开。但 auto-capture 在启动期会用真实 token 发一次
#     "ping" 请求消耗额度,生产环境通常依赖 fixture/FALLBACK_PROFILE 已经够用,
#     默认 false 保留这个 cost 取舍。设为 true 也能跑,失败仍优雅降级
#     (fixture/FALLBACK_PROFILE 兜底,见 src/kiro/auto-capture.ts 和
#     client-profile.ts),只是会打 warn。
#   - HOME=/home/kiro 必须显式设置:USER 是 kiro(uid 1001),但 docker 默认 HOME=/root。
#     kiro-cli login 按 $HOME 把凭据写到 $HOME/.local/share/kiro-cli/data.sqlite3,
#     不设则写到 /root/...,而 core 从绝对路径 KIRO2CLAUDE_SQLITE_DB_PATH 的
#     /home/kiro/... 读 + 卷也只挂这里 → 路径错位:login 成功却"加载凭据失败"、
#     挂载点恒空、容器无限重启。两者必须同源 /home/kiro。
#   - KIRO2CLAUDE_SQLITE_DB_PATH 指向 kiro 用户的默认 kiro-cli SQLite 位置,用户
#     只需挂载卷到 /home/kiro/.local/share/kiro-cli 即可完成持久化
#   - 如果配合 KIRO2CLAUDE_LOGIN_START_URL,首次启动会 spawn kiro-cli login 完成
#     device flow 认证；后续重启因 SQLite DB 已存在会跳过
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    KIRO2CLAUDE_CLI_VERSION=${KIRO2CLAUDE_CLI_VERSION} \
    KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=false \
    KIRO2CLAUDE_PLUGIN_ROOT=/app \
    HOME=/home/kiro \
    KIRO2CLAUDE_SQLITE_DB_PATH=/home/kiro/.local/share/kiro-cli/data.sqlite3

# 在镜像 metadata 里也留一份版本信息
LABEL org.opencontainers.image.title="kiro2claude" \
      org.opencontainers.image.description="Claude API compatible proxy for Kiro (AWS CodeWhisperer)" \
      kiro2claude.kiro-cli.version=${KIRO2CLAUDE_CLI_VERSION}

# Health check：每 30 秒探测 /health，3 秒超时，启动后 10 秒开始，连续 3 次
# 失败标记 unhealthy。K8s 环境下通常由 livenessProbe 接管，此指令不生效。
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${KIRO2CLAUDE_PORT:-8080}/health || exit 1

# 使用 tini 作为 PID 1，正确转发 SIGTERM/SIGINT 给 Node 进程
# 所有配置通过环境变量传入，不接受命令行参数
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/index.js"]
