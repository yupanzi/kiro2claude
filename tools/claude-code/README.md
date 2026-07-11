# Claude Code 兼容性测试 harness

> **位置约定**：本目录是开发/测试用的 Docker harness（shell + Dockerfile），**不是** runtime KiroPlugin，也不随发布镜像打包。位于仓库 `tools/` 下。

通过 Docker 容器运行真实的 Claude Code CLI，请求经 kiro2claude 网关转发到上游 Kiro / AWS CodeWhisperer，用于人工点验和自动化兼容性回归。

本目录有两条用法路径：

- **交互式** — `./run.sh` 起一个真实的 CC REPL，人肉点验
- **自动化** — `./test.sh` 跑 headless 测试套件，验证 kiro2claude 网关对真实 CC 客户端的兼容性（见末尾 [自动化测试](#自动化测试)）

## 目录结构

```
tools/claude-code/
├── VERSION                  # 单一版本来源（被 Dockerfile / run.sh / test.sh 共享），默认 latest
├── Dockerfile               # 镜像定义（Node 24 + Claude Code）
├── run.sh                   # 交互式启动脚本
├── test.sh                  # 自动化测试套件入口
├── entrypoint.sh            # 容器入口（根据环境变量生成 settings.json）
├── claude-settings.json     # .claude/settings.json 模板
└── README.md
```

## 前置条件

- Docker Desktop（macOS/Windows）或 Docker Engine（Linux）
- kiro2claude 网关已启动并监听（默认 `localhost:8080`）
- 有效的 API key（格式 `cc-{username}-{provider}-{hex}`）

## 快速启动

```bash
# 交互式（会提示输入 token 等参数）
./tools/claude-code/run.sh

# 一行命令
./tools/claude-code/run.sh \
  -t cc-admin-kiro-xxx \
  -w ~/projects/myapp
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-t, --token` | API 认证 token | （必填，或交互输入） |
| `-u, --url` | 代理网关地址 | `http://host.docker.internal:8080/claude` |
| `-v, --version` | Claude Code 版本 | `VERSION` 文件值（默认 `latest`） |
| `-n, --network` | 网络模式 `bridge` / `host` | `bridge` |
| `-w, --workspace` | 挂载的宿主机工作目录 | （无） |
| `--build` | 强制重新构建镜像（latest 模式自动 `--pull --no-cache`） | - |
| `--shell` | 以 bash 进入容器调试 | - |

## 网络模式

### bridge（默认，macOS/Windows 推荐）

容器通过 `host.docker.internal` 访问宿主机。macOS Docker Desktop 自动支持；Linux 会自动添加 `--add-host`。

### host（Linux 推荐）

容器共享宿主机网络栈，`127.0.0.1` 直接可达。脚本会自动将 URL 中的 `host.docker.internal` 替换为 `127.0.0.1`。

```bash
./tools/claude-code/run.sh -t TOKEN -n host
```

> macOS Docker Desktop 不支持 `--network host`，请使用默认 bridge 模式。

## 数据持久化

容器的 `/home/claude` 目录挂载到 Docker named volume `kiro2claude-cc-home`，包含：

- `.claude/` — 会话历史、项目记忆

数据在容器销毁后仍然保留。清理方式：

```bash
docker volume rm kiro2claude-cc-home
```

## 工作目录挂载

使用 `-w` 将宿主机项目目录挂载到容器内 `/workspace`：

```bash
./tools/claude-code/run.sh -t TOKEN -w ~/projects/myapp
```

容器内 Claude Code 会在 `/workspace` 目录启动，可以直接读写项目文件。

## 调整 Claude Code 版本

**默认始终跟 npm latest**：`VERSION` 文件内容为字面量 `latest`，镜像 build 时 `npm install -g @anthropic-ai/claude-code@latest` 总会拉到最新发行版。

镜像构建时 Dockerfile 会用 `node -p "require('@anthropic-ai/claude-code/package.json').version"` 把**实际**拉到的版本号写入容器内 `/etc/cc-version`——这是事后唯一可信版本来源（`docker run --rm --entrypoint cat IMAGE /etc/cc-version`），LABEL 不再依赖。

### 锁定某个固定版本（回归用）

`X.Y.Z` 是占位符,替换为实际 semver（例如查 `npm view @anthropic-ai/claude-code versions --json` 拿当前可用版本号）。

```bash
echo "X.Y.Z" > tools/claude-code/VERSION   # 改 VERSION 文件
./tools/claude-code/run.sh -t TOKEN --build

# 或命令行临时覆盖,不改 VERSION 文件
./tools/claude-code/run.sh -t TOKEN -v X.Y.Z --build
CLAUDE_CODE_VERSION=X.Y.Z ./tools/claude-code/test.sh --build
```

### latest 模式的 cache 陷阱

docker 默认会缓存 `RUN npm install -g ...@latest` 这层，build-arg 字符串不变就不会重拉。`run.sh` / `test.sh` 在 `CC_VERSION == "latest"` 时**自动**给 `docker build` 加 `--pull --no-cache`，强制 RUN 层重做。固定版本号则不加（build-arg 改变天然触发重建）。

镜像 tag 跟随 `CC_VERSION`：`kiro2claude-cc:latest` / `kiro2claude-cc-test:latest`（latest 模式）；`kiro2claude-cc:<X.Y.Z>`（固定版本）。

## 调试

```bash
# 以 bash 进入容器
./tools/claude-code/run.sh -t TOKEN --shell

# 容器内检查配置
cat ~/.claude/settings.json
claude --version
cat /etc/cc-version    # build 时落地的实际版本号
```

## 自动化测试

`test.sh` 用真实的 Claude Code CLI 经 kiro2claude 网关跑一组 headless 用例,覆盖项目 `test/e2e/live.test.ts` 没覆盖到的"真客户端 wire 兼容性"维度。

### 前置

- kiro2claude 网关已在本地 `:8080` 启动（`pnpm dev` 或 docker）——`test.sh` 会自动 probe `/health` 失败立即报错
- 宿主机有 `docker` / `jq` / `curl`
- 仓库根 `.env` 里有 `KIRO2CLAUDE_API_KEY`（或 `-t` 显式传）

### 入口

```bash
./tools/claude-code/test.sh                     # 全套（默认 latest）
./tools/claude-code/test.sh --case 01-ping      # 单 case
./tools/claude-code/test.sh -m claude-opus-4.7 --case 04-models   # 矩阵里单跑 4.7
./tools/claude-code/test.sh -v X.Y.Z --build    # 跨版本回归（X.Y.Z 替换为实际 semver）
```

退出码：全 pass → 0；任一 fail → 1；Ctrl-C → 130（trap 清理所有孤儿容器和临时目录后再退出）。

### Case 清单

| Case | 测什么 | 关键断言 |
|---|---|---|
| `00-version` | 镜像版本号自洽 sanity check | `/etc/cc-version` 是合法 semver；容器内 `claude --version` 输出含同一版本号；若 `-v` 锁了固定版本，校验实际拉到的等于请求的 |
| `01-ping` | 非流式 JSON 输出 | `.result` 含 PONG + `.session_id` 非空 + `.total_cost_usd` 数值 + `.usage.input_tokens > 0` |
| `02-stream` | `stream-json` 流式 SSE | 至少 1 行 `type=stream_event` + 至少 1 行 `text_delta` + 末行 `type=result` |
| `03-tool-use` | 工具调用（挂载 workspace + `--allowedTools Read`） | CC 真实通过 Read 工具读到 `/workspace/secret.txt` 并把内容返回 |
| `04-models` | 多模型矩阵（reasoning native + 旧路径） | 对 `opus-4.7` / `opus-4.6` / `sonnet-4.6` 各跑一次 ping，保证 `.usage.input_tokens` 不掉 |

### 生命周期清理

容器命名约定 `kiro2claude-cc-test-*`，每个 case 用 `--rm` 自动消失。脚本 `trap INT TERM EXIT` 兜底：

- 删任何残留的同前缀容器（即便上次崩了）
- 删 `03-tool-use` 的临时 workspace 目录（`/tmp/kiro2claude-cc-ws-*`）
- 删 stderr 捕获临时文件

测试 image tag (`kiro2claude-cc-test:<version>`) 与交互式 image tag (`kiro2claude-cc:<version>`) 分开存放，互不干扰。

### 网络模式自动决策

- **Linux** — `--network host` + 容器内 `http://127.0.0.1:8080/claude`
- **macOS** — bridge + `--add-host=host.docker.internal:host-gateway` + 容器内 `http://host.docker.internal:8080/claude`

用户传 `-u <URL>` 时直接用，但 macOS 上传 `127.0.0.1` 类的 URL 会被脚本拒绝（macOS Docker Desktop 不支持 `--network host`）。

### 跨版本回归

```bash
# 锁定一个非 latest 版本做回归（VERSION 文件保持 latest，命令行临时覆盖；X.Y.Z 替换为实际 semver）
./tools/claude-code/test.sh -v X.Y.Z --build

# 跑完后清理掉该版本镜像
docker rmi kiro2claude-cc-test:X.Y.Z
```
