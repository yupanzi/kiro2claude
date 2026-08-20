# OpenAI Codex 兼容性测试 harness

> **位置约定**:本目录是开发/测试用的 Docker harness,**不是** runtime plugin,不随发布镜像打包。位于仓库 `tools/` 下,与 [`tools/claude-code/`](../claude-code/) 对称。

通过 Docker 容器运行真实的 **OpenAI Codex CLI**,请求经 kiro2claude 网关的 **OpenAI Responses API** 端点(`/openai/v1/responses`)转发到上游 Kiro,跑真实 GPT 模型。用于人工点验网关对真实 Codex 客户端的兼容性。

## 为什么是 Responses API(不是 Chat Completions)

Codex CLI **0.122+ 移除了 `wire_api = "chat"`**,只支持 **Responses API**(实测:配 `wire_api="chat"` 直接报错 `no longer supported`)。所以本 harness 用 `wire_api = "responses"`,网关的 `/openai/v1/responses` 端点接住(见 [踩坑「Codex 只说 Responses」](../../CLAUDE.md))。

## ⚠ Codex 按模型名走两套请求形态

抓包对比得到(⚠ 判别只看**字段在不在**,别按模型名分支):

| 模型名 | Codex 行为 | 工具在哪 |
|---|---|---|
| `gpt-5.6-sol`(**认识**) | **code mode** | `input[0]` 的 `additional_tools` item;顶层 `tools` / `instructions` **都不存在** |
| `gpt-5-codex` / `o3` / `sol`(不认识) | 打 `Model metadata not found` 警告后 fallback | 顶层 `tools`(10 个,扁平,0.147 后不变) |

code mode 的工具集是 `exec`(**`type:"custom"`** freeform,lark grammar)+ `wait` + `request_user_input` + `collaboration`(namespace)。**所有真实工具——`apply_patch` 写文件、`exec_command` 执行命令、`update_plan`、`view_image`——都不是独立 tool**,只写在 `exec` 那约 10K 字符描述里的 TS 声明中;模型必须调 `exec` 传一段 JS(`await tools.apply_patch(...)`)才能干活。

**⚠ 0.147.0 起 code mode 的工具定义多包一层 namespace**(PR [#37022](https://github.com/openai/codex/pull/37022),无配置可回退):原顶层扁平的 `exec`/`wait`/`request_user_input` 折进 `{type:"namespace",name:"functions",tools:[…]}` 容器,子工具形状不变;`collaboration` namespace 照旧。同版本另一变化:`function_call_output.output` 变成 **content part 数组**(router 拒绝时才是字符串)。网关两者都已接住——展开规则与理由见 `core/src/openai/responses/converter.ts` 的 `expandDefaultNamespace` 头注释,**此处不复述**。

网关两套形态都支持(`core/src/openai/responses/converter.ts` 的 `collectTools`;freeform 工具包成单 `input` 字符串字段的 JSON 工具转发,响应侧还原成 `custom_tool_call`),所以 **harness 默认直接用真名 `gpt-5.6-sol`**。换 terra/luna 档位直接 `-m gpt-5.6-terra` 即可。

> 非默认 `namespace` 工具(`collaboration` / `multi_agent_v1`)**故意不转发**:实测其子工具裸名与 `collaboration.list_agents` 都被拒(`unsupported call: list_agents`)。规则与理由同上,见 `expandDefaultNamespace` 头注释。

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
| `-m, --model` | Codex model | `gpt-5.6-sol` |
| `-v, --version` | Codex 版本 | `VERSION` 文件(`latest`) |
| `-n, --network` | `bridge` / `host` | `bridge` |
| `-w, --workspace` | 挂载到 `/workspace` | (无) |
| `--build` | 强制重建(latest 自动 `--pull --no-cache`) | - |
| `--shell` | bash 进容器调试 | - |
| `-- <args>` | 原样透传给 `codex`(如 `-- exec "..."`) | - |

## 实测结论(已跑通)

> 端到端验证跑在 Codex **0.144.4 / 0.146.0**(扁平工具形态);**0.147.0 / 0.148.0**(`functions` namespace 嵌套形态)用本地抓包/应答服务器验证:抓真实请求定格式、伪造 `custom_tool_call`/`function_call` 响应实测回程名字分发(裸名 `exec`/`wait` 被执行,`collaboration` 子工具被拒)。此处是本仓唯一记录**端到端验证过哪些 Codex 版本**的地方;别处(源码、测试、脚本与其它文档)出现的版本号只标注某个 wire 形态**何时**开始出现——判别 code mode 与 namespace 展开一律只看**字段在不在**,任何地方都不按版本走不同路径。

- ✅ **对话**:`codex exec "..."` → 网关 `/openai/v1/responses` → gpt-5.6-sol → 正确回答。
- ✅ **工具调用(fallback 形态)**:`gpt-5-codex` → Codex 发 10 个顶层工具 → 模型 function_call → 容器内真实执行(如 `/bin/bash -lc 'uname -s'` → `Linux`)→ 结果回填 → 模型最终答案(多轮 function_call 全通)。
- ✅ **工具调用(code mode)**:`gpt-5.6-sol` → `additional_tools` 里的 freeform `exec` → 网关编码 `custom_tool_call` → Codex 执行 JS 里的 `tools.apply_patch(...)` → 文件真实落到挂载的 workspace。
- 容器内沙箱设 `danger-full-access` + `approval_policy=never`(容器本身即隔离,避免 landlock/seatbelt 在 Docker 里的兼容问题)。

## 调试

```bash
./tools/codex/run.sh -t TOKEN --shell         # bash 进容器
cat ~/.codex/config.toml                       # 看生成的配置
codex --version; cat /etc/codex-version        # 版本
# 容器内加 RUST_LOG=codex_core=debug 看 Codex 内部事件解析
```
