# OpenAI Codex 兼容性测试 harness

> **位置约定**:本目录是开发/测试用的 Docker harness,**不是** runtime plugin,不随发布镜像打包。位于仓库 `tools/` 下,与 [`tools/claude-code/`](../claude-code/) 对称。

通过 Docker 容器运行真实的 **OpenAI Codex CLI**,请求经 kiro2claude 网关的 **OpenAI Responses API** 端点(`/openai/v1/responses`)转发到上游 Kiro,跑真实 GPT 模型。用于人工点验网关对真实 Codex 客户端的兼容性。

## 为什么是 Responses API(不是 Chat Completions)

Codex CLI **0.122+ 移除了 `wire_api = "chat"`**,只支持 **Responses API**(实测:配 `wire_api="chat"` 直接报错 `no longer supported`)。所以本 harness 用 `wire_api = "responses"`,网关的 `/openai/v1/responses` 端点接住(见 [踩坑 #17](../../CLAUDE.md))。

## ⚠ 模型名必须用 `gpt-5-codex`(才有工具集)

实测:**Codex 只对它内部识别的模型名下发工具集**——`gpt-5.6-sol`(自定义名)→ 0 工具;`gpt-5-codex`(Codex 认识)→ 10 工具(shell / apply_patch 等)。所以要工具调用就用 `gpt-5-codex`(harness 默认),网关 `mapModel` 把它**别名**到真实的 `gpt-5.6-sol`。Codex 会打一条 `Model metadata for gpt-5-codex not found, defaulting to fallback` 警告——**cosmetic,不影响功能**。

想换成 terra/luna 档位:改网关 `converter.ts` 里 codex 别名的目标(Codex 端改模型名会丢工具)。

## 前置条件

- Docker Desktop / Engine
- kiro2claude 网关已启动(默认 `localhost:8080`;监听 `0.0.0.0` 才能被容器 `host.docker.internal` 访问)
- 有效 API key

## 快速启动

```bash
# 交互式 REPL(会提示输入 token)
./tools/codex/run.sh -t sk-local-test

# headless 单次(工具调用会真实在容器内执行)
./tools/codex/run.sh -t sk-local-test -u http://host.docker.internal:8080/openai/v1 \
  -- exec "Run 'uname -s' and tell me the output"

# 挂载项目目录做真实编码任务
./tools/codex/run.sh -t sk-local-test -w ~/projects/myapp
```

## 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `-t, --token` | API token → `KIRO2CLAUDE_API_KEY` | (必填/交互) |
| `-u, --url` | 网关 OpenAI 端点 | `http://host.docker.internal:8080/openai/v1` |
| `-m, --model` | Codex model(保持 `*codex*` 名字才有工具) | `gpt-5-codex` |
| `-v, --version` | Codex 版本 | `VERSION` 文件(`latest`) |
| `-n, --network` | `bridge` / `host` | `bridge` |
| `-w, --workspace` | 挂载到 `/workspace` | (无) |
| `--build` | 强制重建(latest 自动 `--pull --no-cache`) | - |
| `--shell` | bash 进容器调试 | - |
| `-- <args>` | 原样透传给 `codex`(如 `-- exec "..."`) | - |

## 实测结论(已跑通)

- ✅ **对话**:`codex exec "..."` → 网关 `/openai/v1/responses` → gpt-5.6-sol → 正确回答。
- ✅ **工具调用**:`gpt-5-codex` 别名 → Codex 发 10 个工具 → 模型 function_call → 容器内真实执行(如 `/bin/bash -lc 'uname -s'` → `Linux`)→ 结果回填 → 模型最终答案(多轮 function_call 全通)。
- 容器内沙箱设 `danger-full-access` + `approval_policy=never`(容器本身即隔离,避免 landlock/seatbelt 在 Docker 里的兼容问题)。

## 调试

```bash
./tools/codex/run.sh -t TOKEN --shell         # bash 进容器
cat ~/.codex/config.toml                       # 看生成的配置
codex --version; cat /etc/codex-version        # 版本
# 容器内加 RUST_LOG=codex_core=debug 看 Codex 内部事件解析
```
