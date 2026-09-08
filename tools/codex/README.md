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

**⚠ 0.147.0 起 code mode 的工具定义多包一层 namespace**(PR [#37022](https://github.com/openai/codex/pull/37022),无配置可回退):原顶层扁平的 `exec`/`wait`/`request_user_input` 折进 `{type:"namespace",name:"functions",tools:[…]}` 容器,子工具形状不变;`collaboration` namespace 照旧。同版本另一变化:`function_call_output.output` 变成 **content part 数组**(router 拒绝时才是字符串)。网关两者都已接住——展开规则与理由见 `core/src/openai/responses/converter.ts` 的 `expandNamespaces` 头注释,**此处不复述**。

工具结果中的 `input_image`(如 `view_image` 或 code mode 的 `image(...)`)也会随文本一起转发:内联 base64 图片提升到上游消息的 `images`,多轮历史重放时同样保留。远程图片 URL 留下明确的未读取提示,网关不代抓外链。

网关两套形态都支持(`core/src/openai/responses/converter.ts` 的 `collectTools`;freeform 工具包成单 `input` 字符串字段的 JSON 工具转发,响应侧还原成 `custom_tool_call`),所以 **harness 默认直接用真名 `gpt-5.6-sol`**。换 terra/luna 档位直接 `-m gpt-5.6-terra` 即可。

> 非默认 `namespace`(`collaboration`)**也会展开**,但子工具必须带 `namespace` 字段回程,否则被拒(`unsupported call`)。规则见 `expandNamespaces` 头注释,实测对照见下一节。

## subagent(`spawn_agent`):**已支持**(2026-09-07)

> **本节此前写的是「网关侧无解、不要试着放开」,那条结论是错的**,已被下面的对照实验推翻。
> 原观察(裸名展开后 router 回 `unsupported call`)属实,错在归因:不是客户端不注册
> handler,而是**响应侧少了一个 `namespace` 字段**。

`collaboration` namespace 里的六个工具(`spawn_agent` / `list_agents` / `send_message` /
`wait_agent` / `followup_task` / `interrupt_agent`)就是 Codex 的 subagent 能力。Codex v2 用的是
一套**扩展 wire format**,网关现已实现其中三项:

| 实现项 | 位置 | 漏了会怎样 |
|---|---|---|
| 请求侧展开 `collaboration`,记下每请求的 `名字 → namespace` 映射 | `converter.ts` `expandNamespaces` / `collectTools` | 零工具上送,模型根本看不到 subagent |
| schema 里递归剥私有关键字 `encrypted`(**只对展开的 namespace 工具**) | `converter.ts` `stripEncryptedKeyword` | 上游可能拒收或吐空参数 |
| 响应侧把 `namespace` 写回 `function_call`(流式 + 非流式) | `response-stream.ts` / `response-nonstream.ts` | **`unsupported call: spawn_agent`** |
| 线程间信封转换(`agent_message` → user 消息) | `converter.ts` `convertAgentMessage` | `NEW_TASK` 丢 → 子线程收到**空 Payload**;`FINAL_ANSWER` 丢 → 父线程**看不到子 agent 的答案** |

⚠ 客户端仍须开 `agents.enabled = true`(本 harness 的 `entrypoint.sh` **不设**它);
`gpt-5.6-sol` 的模型目录自带 `multi_agent_version="v2"`,无需另配。

### 决定性对照(0.153.4,2026-09-07,零上游成本)

四个挂载点,变量只有两个:请求侧展没展开 `collaboration`、响应侧加没加 `namespace` 字段。
之后向客户端派发**同一个** `spawn_agent` 调用,答案在它回传的 `function_call_output` 里。

| case | 请求侧展开 | 响应侧 `namespace` | 客户端回传 | 每轮 input tokens |
|---|---|---|---|---|
| `no-expand`(修复**前**的生产行为) | ✗ | ✗ | `unsupported call: spawn_agent` | 19,232 |
| `expand` | ✓(6 个工具) | ✗ | `unsupported call: spawn_agent` | 22,560 |
| `ns-only` | ✗ | ✓ | **`{"task_name":"/root/probe"}`** 子 agent 已创建 | 19,232 |
| `ns-restore` | ✓ | ✓ | **`{"task_name":"/root/probe"}`** 子 agent 已创建 | 22,560 |

修复后再跑 `no-expand`(探针不做任何改写 = 纯网关逻辑):`tool_count=9`、
`namespaced_tool_count=6`、子 agent 创建成功、日志出现
`responses: converted multi-agent envelope`(`message_type:"NEW_TASK"`、`body_converted:true`),
且 `taskBodyReachedUpstream=true`——子任务正文确实进了上游请求,不再是空 Payload。

**决定路由成败的是响应侧那个 `namespace` 字段,不是请求侧展开。** 少了它,router 按裸名查不到
handler;补上它,同一个调用立刻被受理(中间态可见:参数缺 `task_name` 时错误从
`unsupported call` 变成 `failed to parse function arguments`,证明已经进了 collaboration handler)。

请求侧展开仍然**必需**,但理由不同:探针是强制派发,真实场景里模型得先在工具表里看见
`spawn_agent` 才会调用它。两者是**互补**的,不是二选一。

### 线程间信封:**三类**都要转(修复前都被丢掉或丢正文)

实测有三类 `agent_message` 信封,少转任何一个都让功能失效:

```text
父 → 子   author=/root          recipient=/root/probe
          partTypes=[input_text, encrypted_content]
          head="Message Type: NEW_TASK\nTask name: /root/probe\nSender: /root\nPayload:\n"
          ↑ 任务正文在 encrypted_content 里

子 → 父   author=/root/probe    recipient=/root          (send_message 发出的中间消息)
          partTypes=[input_text, encrypted_content]
          head="Message Type: MESSAGE\nTask name: /root\nSender: /root/probe\nPayload:\n"
          ↑ 消息正文同样在 encrypted_content 里

子 → 父   author=/root/probe    recipient=/root          (交活)
          partTypes=[input_text]
          head="Message Type: FINAL_ANSWER\nSender: /root/probe\nPayload:\n<答案>"
          ↑ 答案就在 input_text 的 Payload 段
```

最初两类都落进 `responses: unknown input item types ignored  item_types:["agent_message"]`。
第一轮修复只把 `NEW_TASK` 的 `encrypted_content` 转成明文,`MESSAGE` 的正文于是被当
「语义未知的同名字段」跳过——父线程只见空 `Payload:`,把它误读成一句简短确认(「过早的
OK」)。spawn / NEW_TASK / FINAL_ANSWER 全部正常,固定 nonce 端到端返回
`{"message":"EMPTY","final":"FINAL_NONCE_…"}` 才看得出来(2026-09-08 修复)。

★ **`FINAL_ANSWER` 这条最隐蔽**:`wait_agent` 的工具结果只有
`{"message":"Wait completed.","timed_out":false}`,**不含答案本身**。所以丢了它,
spawn/wait 全部成功、日志全绿、`turn.completed` 正常,父线程模型却在空手总结——
本轮就是先修完 `NEW_TASK` 跑生命周期时,靠 nonce 对不上才发现的。

现由 `convertAgentMessage` 统一处理,判据**分两层**(别合并):转不转这条信封看有没有
结构化 `Message Type:` 头(不逐个白名单——新类型丢弃 = 模型失明);`encrypted_content`
转不转明文**只看 `Message Type` 在不在白名单 `NEW_TASK` / `MESSAGE` 里**(整 token 比对;
名单外信封的同名字段语义未知,转出去是泄漏;`reasoning.encrypted_content` 是另一个 item
type、真密文,永不转)。`FINAL_ANSWER` 实测正文在 `input_text`,**不在**名单里;升级 Codex 后
若发现它也改成分离正文,先抓脱敏 fixture 确认再扩。

### 生命周期矩阵(0.153.4,真实 CLI,零上游成本)

`test/manual/codex-subagent-lifecycle-server.ts`。判据是 **nonce 配对**不是「有没有报错」:
每个 spawn 的任务正文埋唯一 nonce,子线程原样回,父线程必须在 `FINAL_ANSWER` 里收到
**对应那一个**;串线靠信封 `author` 与 nonce 是否配对来检出。`message` 场景另有一个
中间 nonce,判据是**入口有、上游也有**:子线程 `send_message` 后,父线程请求入口的
`MESSAGE` 信封 `encrypted_content` 含它(客户端没丢)且转换后的上游请求也含它(网关没丢);
前有后无 = `lostAtGateway > 0`,同时进 `mismatches`。

| 场景 | 覆盖 | 结果 |
|---|---|---|
| `single` | spawn → 子线程执行 → wait → 结果回父线程 | nonce 送达 1 次、回收 1 次 |
| `concurrent` | 同一响应里发两个 spawn | a→a、b→b,**无串线** |
| `followup` | 同一子 agent 派第二个任务 | 两个 nonce 各送达 1 次、各回收 |
| `interrupt` | spawn → interrupt_agent → list_agents | 中止正常,无串线(此场景不要求任务跑完) |
| `timeout` | `timeout_ms:1` 后再长 wait | 超时不谎报完成,后续 wait 仍取到最终结果 |
| `fork-turns` | `none` 与 `all` 各一轮 | 两者都正常 |
| `fault-retry` | spawn 后注入一次 503 | 客户端重试后 **spawn 不重复**(送达仍为 1 次) |
| `message` | 子线程 `send_message` 给父线程一个中间 nonce,父线程 wait 两次 | 入口 2/2 有正文、上游 2/2 有正文,`lostAtGateway=0`,FINAL_ANSWER 也回收;修复前对照:入口 2/2、上游 **0/2** |

8/8 通过(2026-09-08 复跑)。跑法两种都验过:全部 8 个场景用本机 npm 装的 `codex` 0.153.4 +
隔离 `CODEX_HOME`(`base_url` 指 `127.0.0.1:18962`);`message` 场景另在本仓库的 harness 镜像
`kiro2claude-codex:0.153.4` 里按下面「复跑」一节的 `docker run` 命令取了两个干净样本
(每个样本重启一次探针——场景状态是进程内累计的,同一进程跑第二遍会从上次的 step 接着走)。
⚠ 探针自身的四个坑已修,别再踩:nonce 必须按**完整 token** 匹配(`NONCE_X_a` 会命中
`NONCE_X_a_SECOND`,followup 因此假阴性);`interrupt` 场景**不能**把「任务未送达」当失败
——中止本来就发生在送达之前;伪造的正常响应**必须**以 `buildMetadataFrame()` 收尾
(踩坑「帧边界 EOF」)——漏掉时网关按规范判 `max_tokens`、Codex 对每条回复
`Incomplete response … max_output_tokens` 重连 5 次后 `turn.failed`,整套剧本走不动;
`message` 场景父线程要 **wait 两次**——子线程的 `send_message` 会唤醒第一次 `wait_agent`
(「Wait completed.」先于 FINAL_ANSWER 回来),只 wait 一次时 FINAL_ANSWER 赶不赶得上父线程
最后一轮纯看时序(本机赶上、Docker 没赶上),会把时序当成回收失败。

### 还没验证的(合并到生产前应补)

| 项 | 现状 |
|---|---|
| **规模**:单 agent 连续 20 轮、双 agent 并发 10 轮全部 nonce 正确 | 只各跑过 1 轮。探针支持重复跑,但没做统计 |
| `spawn_agent.arguments` 会不会因 schema 私有关键字退化成 `{}` | 探针**手工构造**参数,绕过了模型生成这一步;需真实模型验 |
| 「模型拿到失败工具后无限重试 110+ 次」 | 来自真实模型会话,假 provider 不模拟模型决策,复现不了 |
| 429 / 断流(非 503)下的 spawn 幂等 | 只注入过 `transient 503` |
| 真实上游下的流式增量、负载与并发 | 全部用假 provider;真实 Kiro 环境未跑 |

### 复跑

```sh
K2C_SUBAGENT_PORT=18961 K2C_SUBAGENT_TOOL=spawn_agent \
  pnpm --filter @kiro2claude/core exec tsx test/manual/codex-subagent-probe-server.ts
```

客户端必须开 `agents.enabled = true`(harness 默认的 `entrypoint.sh` **没有**开;
`gpt-5.6-sol` 的模型目录里已带 `multi_agent_version="v2"`,不用另配):

```sh
docker run --rm --entrypoint bash -e KIRO2CLAUDE_API_KEY=subagent-probe-key \
  kiro2claude-codex:0.153.4 -c 'mkdir -p ~/.codex && cat > ~/.codex/config.toml <<EOF
model = "gpt-5.6-sol"
model_provider = "kiro2claude"
sandbox_mode = "danger-full-access"
approval_policy = "never"
[agents]
enabled = true
[model_providers.kiro2claude]
name = "kiro2claude"
base_url = "http://host.docker.internal:18961/case/ns-restore/openai/v1"
env_key = "KIRO2CLAUDE_API_KEY"
wire_api = "responses"
EOF
codex exec --json --skip-git-repo-check "Spawn a subagent to say hello." < /dev/null'
```

把 `ns-restore` 换成 `no-expand` / `expand` / `ns-only` 即其余三组。
`K2C_SUBAGENT_TOOL=exec` 是必跑的对照组:它会真的执行 `echo CONTROL_OK` 并 `exit_code:0`,
证明拒绝来自 router 而不是网关编码坏了。

⚠ 探针验证的是 **router 是否受理调用**。两件事它**证明不了**,别拿它当证据:
① 「模型无限重试 110+ 次」来自真实模型会话,假 provider 不模拟模型决策;
② schema 里的 `encrypted` 关键字会不会让 `spawn_agent.arguments` 退化成 `{}`——探针手工构造
参数,绕过了模型生成这一步,需要真实模型才能验。

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

> 端到端验证跑在 Codex **0.144.4 / 0.146.0**(扁平工具形态)与 **0.153.4**(`functions` + `collaboration` 双 namespace 形态,`exec` / 交互 TUI 两条路径都跑过真实会话);**0.147.0 / 0.148.0**(`functions` namespace 嵌套形态)用本地抓包/应答服务器验证:抓真实请求定格式、伪造 `custom_tool_call`/`function_call` 响应实测回程名字分发(裸名 `exec`/`wait` 被执行,`collaboration` 子工具被拒)。此处是本仓唯一记录**端到端验证过哪些 Codex 版本**的地方;别处(源码、测试、脚本与其它文档)出现的版本号只标注某个 wire 形态**何时**开始出现——判别 code mode 与 namespace 展开一律只看**字段在不在**,任何地方都不按版本走不同路径。

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
