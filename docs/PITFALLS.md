# 踩坑陷阱:来龙去脉与实测证据

[CLAUDE.md](../CLAUDE.md)「高频踩坑陷阱」每条只留红线与真相源,这里是同名条目的长版:为什么这样定、实测看到了什么、怎么复跑。标题与 CLAUDE.md 一一对应,改标题两处同步。证据数据以代码头注释与守卫测试为准;这里只保留代码里没有归宿的部分(`test-results/` 不进仓库)。

## 请求转换 · 工具(Claude→Kiro)

### 注入文本

Kiro `conversationState` 只有 user/assistant,`userInputMessageContext.additionalContext`(Smithy 模型里唯一像上下文通道的结构化字段)上游 200 但**静默丢弃**(2026-09-10 直连实测:塞进去的秘密码模型答 UNKNOWN、指令被无视、input token 不变)。所以 system 文本 = `buildSystemPrefix`(客户端 system + 旧模型 `<thinking_mode>` 前缀 + 可选身份指令)→ `foldSystemIntoFirstUserMessage` 在 **Kiro 消息层**拼到首条 user 消息最前(首轮 = currentMessage,之后 = history 首条 user;图例之后拼,字符串 / 块数组 content 字节一致);后续 user 轮次(含纯 tool_result)原文不动;末尾 user 连串整体 = 当前轮(Anthropic 语义),history 必以 assistant 收尾。

**已移除**的两个合成轮次:开场 `user: system / assistant: "I will follow these instructions."`(抄 kiro-cli 的形态)与末尾补 `assistant: "OK"`。前者会被模型当真实历史逐字引用(零注入基线答 NONE),后者让同一段对话在下一轮被 `mergeUserMessages` 合并、形态随轮次漂移。长上下文 + 真实工具执行的 A/B 证明两者零收益,数据在 `foldSystemIntoFirstUserMessage` / `buildHistory` 头注释。**身份覆写与注入方式无关地不可靠**(user 级权重压不过上游系统提示)→ `KIRO2CLAUDE_IDENTITY_OVERRIDE` 默认关,数据在 `IDENTITY_OVERRIDE_DIRECTIVE` 头注释。

**中途插入的内容**(2026-09-11 专项):录得的 5923 条真实 Claude Code 请求里 2023 条含 `role:system` 消息,**永远紧跟一条 user 之后**(中途 3730 条是字符串、收尾 176 条是文本块数组;内容是权限模式指令 / 「文件已在磁盘上变更」/ `<total_tokens>`)。只走 `foldSystemMessages` 折进相邻 user 轮,重放全部零丢失、收尾的落 currentMessage、中途的落对应 history user;7 种形态(收尾 / 中途 system、tool_result 后排队的用户文本、ESC 打断工具 / 文本、首条 reminder、assistant 起手)真实上游 nonce 7/7 回,**assistant 起手的 history 上游接受**(Kiro 不要求 user 起手)。顺手修掉三处同根问题:① system 前缀改在 Kiro 消息层拼——此前折进 ClaudeMessage,字符串 content 得 `SYS\n\nx` 而块数组只得 `SYS\nx`(CC / Codex 发的都是块数组),≥2 图时图例会排到 system 前面,`<thinking_mode>` 去重也只看 system 不看折叠目标;② 非 user/assistant/system 的 role 由静默丢弃改为 **400 `InvalidRole`**——静默丢就是丢用户内容,还会让 2.5 步的 continuation 文案融进用户自己的末条消息;③ OpenAI Chat / Responses 只把**开头**那段 system/developer 提升成 system,对话开始后出现的原位保留为 `role:system`(此前一律提到开头,「从现在起…」类中途指令读起来像开场规则)。复跑 `test/manual/replay-content-preservation.ts`(免费)/ `inserted-content-live.mjs`(计费)。

查 wire 字段名看 `aws/amazon-q-developer-cli` 的 Smithy 客户端类型,别对 kiro-cli 二进制 `strings`(连 `toolResults` 都搜不到)。

**2026-09-11 真实 Docker CLI 验收**(CC 2.1.263 / Codex 0.153.4):`tools/claude-code/test.sh` 8/8;CC 三阶段真实编码 107 次调用三段验收全过;Codex 三阶段 35 次调用全过;AskUserQuestion、WebSearch、WebFetch、`/simplify`、`/code-review` 全过;合成探针 CC 10 场景 / Codex 11 / 空响应 9+9 / subagent 生命周期 8 与 09-07 基线逐项一致;CC 六图 2/2 全对,Codex 六图归属抖动经受控 A/B 证明是模型侧既有问题(改前 0/3、改后 3/5,图片轮 wire 逐字节相同)。复跑要点:长会话阶段超时放到 60 分钟(opus-5 extend 约 47 次调用,上游慢时 20/30 分钟窗口的超时不是转换层问题);headless 验 AskUserQuestion 走 `--permission-prompt-tool stdio` 的 `can_use_tool` 控制消息;CC headless 的 init 工具清单本身不含 Glob / Grep / TodoWrite,网关照收全转发,别当网关问题。

### 工具调用文本泄漏

上游解析偶发失败 → 工具调用块以纯文本掉进响应,留在历史会被模型模仿 → 同会话确定性复发。`KIRO2CLAUDE_TOOL_CALL_TEXT_RESCUE`(默认开)双向兜底:响应侧解析回真 tool_use、请求侧剥历史泄漏块。全部红线在 `claude/tool-call-text.ts` 头注释。勿再引入「大文件分块写入」类 prompt 指令(已证伪,连同 `SYSTEM_CHUNKED_POLICY` 移除)。

### tool description cap

Kiro 对**单个** description 无字符硬上限,真限制是 **context window**(多 tool + history + system 撑爆报 400 "Context window is full")。`KIRO2CLAUDE_TOOL_DESCRIPTION_MAX_LEN`(默认 32768)截住畸形超大 description——覆盖已知最大合法工具 Workflow 且留余量;cap 只管单工具,总量保护交给 Kiro 的 400。

### 多图归属只靠顺序

Kiro wire 只有消息级 `images[]`——`toolResults[].content` 塞 Bedrock 风格 `{image}` 上游 200 但**静默丢弃**(2026-09-09 直连实测:模型说结果为空、输入 token 恰好少掉图片量),user 正文是纯字符串也放不进图。所以 tool_result 里的图提升到 `images[]` 后,归属**只剩位置**。三层真实上游实测(`multi-image-attribution-probe.mjs` + `multi-image-cli-probe.mjs`):

1. 两次并行图片工具、回执**反序**时 Claude opus-5 与 GPT-5.6 都按 **tool_use 顺序**对应 `images[i]`,答案整体对调 → `canonicalizeToolResultOrder` 按 tool_use 顺序重排 tool_result 块(只动 tool_result、只在已占槽位间动;分组 = 「连续 user 连串是一轮」,history 里的连串经 `mergeUserMessages` 合并,末尾连串整体是 currentMessage,同走 `processMessageRun`)。
2. 6 张图直接放 user 消息、正文写「附件 1…6 按序」两模型全对 → 上游 N=6 仍保序、模型数得清。
3. **6 个各含一张图的 tool_result**(Claude Code 并行 Read 形态,id 不透明、路径只在 tool_use 输入里)只靠 tool_result 里的序号占位符两模型 4/4 错位,Docker 真 CC 5/6 错、Codex 单次 exec 看 6 图 3/7 错;同一 wire 在 `content` 开头加一行图例后 4/4 全对 → `prependImageLegend`:≥2 张图且至少一张来自 tool_result 时,`content` 前置 `[Attached images, in order: image k = <图前最近一行文本 (tool call id)> | result of tool call <id> (<name> <input≤120>); …]`,tool_result 内占位符同步为 `[image k attached to this message]`。

图例只复述 wire 上已有的事实(序号、tool_use id、调用输入、工具自己打印在图前的路径),**不是指令**;单图、或图全来自用户时不加。与 PR #4 的区别:那个方案给所有 ≥2 图请求塞 `content index` / `source` 元数据加「不是拼块」的指令,而它真正想修的「GPT 把两张相同图数成 1 张」是模型判断(token 计数证明两张都送到了),记在 README「已知限制」。OCR 误读(GPT 对 5×7 点阵 3↔2 / 0↔6 / 5↔6)是模型噪声,探针单独分类、不计失败。

## 流式传输 · 断连 · 空流

### 空流有界重试

上游偶发「200 OK + 零内容帧」,客户端无法与真实过载区分,retry-executor 看不到 2xx 的 event-stream body。**仅 pre-commit**(未写任何字节)对同一请求重发最多 `KIRO2CLAUDE_EMPTY_STREAM_RETRIES`(默认 2)次,已 commit 绝不重试。**确定性空流单次定案、不耗重试预算**(重发只会同样失败、白烧 credit),四类:`max_tokens` / `model_context_window_exceeded` / 截断 tool_use(宣告 tool_use 却无一帧 `isComplete`)/ 上游 Error·Exception 帧**且已开工**。末类限定词必须:零帧拒绝(未开工)属**瞬时**故障、走有界重试。判据用 `sawBillableWork()` 而**不是** `hasContent()`——GPT 加密 reasoning 计费但不 surface,`hasContent()` 会把烧了数千帧 reasoning 的流谎报为空;与 retryable 分类无关(那个集合实测不完整)。文案 `selectEmptyUpstreamMessage` 的 `deterministic` 参数必须显式传,别靠 `emptyAttempts` 倒推。新增判空分支先问「是不是内容绑定的」,是则加进排除列表。红线在 `stream-handler.ts` / `non-stream-handler.ts` / `stream.ts`(`sawCompletedToolUse`)/ `empty-capture.ts` 头注释;不明空流用 `KIRO2CLAUDE_CAPTURE_EMPTY_DIR` 抓包,别盲改 converter。

### 截断 tool_use 必须阻止残缺调用到达客户端

上游偶发宣告工具并发出 input 分片,却未发 `isComplete` 就断流。**只改 `stop_reason=max_tokens` 不够**——2026-09 用无缓存重建的 Claude Code 2.1.263 实测:客户端**先**解析已关闭的工具块、**后**才看终态,仍报 `InputValidationError: JSON parse failed`。故防线必须落在**协议时序**上:`stream.ts` 的 `pendingToolCalls` 按 id 缓存参数,**收到 `isComplete` 才分配 block index 并原样发 start/delta/stop**;文本继续实时流式、参数不修补,未完成调用不上 wire 也不占索引,交错调用按完成顺序发出且参数隔离。非流式 `non-stream-reduce.ts` 同样只保留完成调用。

**参数只有两种合法归宿**:普通工具经 `parseCompletedToolInput` 必须解出 JSON 对象,失败即协议错误——**绝不回退 `{}` 去执行**(那是静默换一个动作);只有 Responses 显式 `customToolNames` 的 raw-input allowlist 保留裸文本,其 wrapper/raw 解码仍由 `freeform-tool.ts` 独占。同族的 wire 校验在解码边界(`kiro/model/events/base.ts`):name/id/input 的类型、以及 `isComplete` 必须是 boolean——字符串 `"false"` 是 truthy,会把未收完的参数当成可执行调用放出去;`ToolUseSequence` 被两个归约共用,拒绝中途改名与完成后复用 id。计费字节仍累计;终态分两形态:零 input 空壳 → 确定性空流,由 `hasIncompleteToolUse()` 识别、单次定案不耗重试;已有 input 或其它内容 → 丢弃未完成调用并保留部分文本,终态 `max_tokens`(不覆盖更具体的既有终态)。Responses 流式/非流式把 `max_tokens` 与 context-window 耗尽映射为 `incomplete` + `max_output_tokens`,**不可改成 `completed`**。真实客户端复测:Claude Code 2.1.263 不再产残缺 tool_use、能续接恢复;Codex 0.153.4 对 incomplete 自动重连并恢复,不执行损坏的 exec。网关自己 abort/destroy 造成的截断由 `ctx.gatewayTruncatedUpstream` 打标并降 info。

### 断连计费

客户端断连后默认 drain 上游到 EOF 拿尾帧 Metering **全额计费**。`KIRO2CLAUDE_ABORT_UPSTREAM_ON_DISCONNECT`(默认 false)开启后断连**主动 abort 上游**(signal 经 provider→retry-executor `axiosConfig` 透传)省下断连点后的 credit;代价是拿不到 Metering、per-request 记账偏低。仅 Claude 端 stream;`logFields.drained_after_disconnect` 观测。该 flag 与 `metering_lost` 的关系是相反的:它消除前者、却让后者在每次断连时为真(见 `isMeteringLost` 头注释的口径偏差)。

### write 背压不是断连

`stream.write()` 返 `false` = 缓冲超 highWaterMark、应等 `'drain'`,socket 健康。误判会停读循环(对**活着的**客户端)、丢终结段 `message_stop`、上游仍 drain 到 EOF **全额计费**、日志还错记客户端;且因缓冲由**大量字节**填满,专咬最长最贵的响应。红线:存活只看 `destroyed`/`writableEnded`/write 抛错;背压走 `awaitDrain`(带 `close`+超时兜底);`disconnect_source` 区分 `client_close`/`write_failed`,**别退回单一 `aborted` 布尔**。真相源 `safeWrite`/`awaitDrain` 头注释。

### legacy thinking 文法

`<thinking>` 是 prompt 诱导出来的**文本内**协议,不是独立 event(产生式见 `claude/stream/legacy-thinking-decoder.ts` 头注释)。识别范围恰好卡在**行首**,两边都试错过:**收紧成「只认响应开头」→ 幻影执行**(模型写句前言再开思考,整段被判可见文本,思考里起草的 `<invoke>` 被救援物化成真 tool_use);**放宽成「任意位置」→ 整个响应变 thinking**(正文里内联提到标签就误开块,严格闭标签文法找不到 `\n\n` 就一路吞到 EOF)。同族三条:① 绝不按标点/引号包裹去猜是真标签还是模型在引用它——旧实现那张 30 字符黑名单查的是闭标签**前一个字符**,于是思考以英文句号收尾就否决闭合(中文 `。` 不在表里,所以只测中文发现不了);② **未闭合的块在 EOF 仍归 thinking**,理由同幻影执行;③ **语法同源还不够,终态判定也必须同源**——实测踩过:流式判「thinking 阶段**开过**」、非流式跟着「thinking 内容非空」走,空块 `<thinking></thinking>\n\n` 于是在流式是 200 + `max_tokens`、在非流式先烧完重试预算再 503。新增任何 thinking 相关分支,先把两条路径对拍一遍。

### 原生 reasoning 的空帧

任意 `reasoningContentEvent`(含空/redacted)都锁 native 模式——那是 GPT 静态判定万一漏判模型别名时的运行时兜底。但空帧两条边界不能越:① 不打断已经开着的 thinking 块(`hasOpenThinking`),强行关块会把剩下的私有推理连同字面 `</thinking>` 推进可见文本;② 不 flush 泄漏工具调用的救援检测器,那只在真要开 thinking block 时才需要(保 wire order),在空帧上做会把跨帧候选拦腰截断——而 redacted 帧的唯一来源恰恰是 GPT。真相源 `processReasoningContent` 头注释。

### 上游杀卡住的流

上游偶发生成中途发泛化 `Exception`(`code:"error"`、**无** `ContextUsage`+`Metering` 尾帧 = 真中途死),已 commit 只能转 in-band `error`,客户端见 mid-response 截断。判别子是**产出速率(token/s)不是总时长**——按时长分桶会得错误死线。网关侧无治本手段(上游行为)、post-commit 也无法重试或改状态码。缓解见 `stream-handler.ts` 的 `armDrainGrace`(目前只在**已断连**时武装,连接中 idle 无上界、只受 axios 720s 约束)。

### 读坏的 body 是失败的响应

三类损坏必须走与显式上游错误帧**同一条**终结路径,只记日志再补一个成功终态等于把故障洗成 `end_turn`:① 读流异常(`ECONNRESET` / `ERR_STREAM_PREMATURE_CLOSE`)经 `StreamContext.recordStreamReadError`(网关主动取消除外,那是自伤);② 帧 CRC 或已知事件的 JSON 解码失败;③ **HTTP 正常 EOF 也不保证 event-stream 完整**——`EventStreamDecoder.assertComplete()` 查残留半帧,末尾攒着不足一帧的字节就是截断。三类都仍继续 drain 以取 Metering,但**错误一旦确定就不再发出后续工具调用**。边界同样重要,别把「没见到」当**故障**:Unknown 事件、任意分片切法、没有 Metering 尾帧都不构成损坏(Metering 缺失只是漏账,见 `isMeteringLost`);「没见到 `metadataEvent`」是**未完成**而非故障(见下一条);已知事件只校验**正在消费的**字段类型(string / finite number),缺字段与原有 null 缺省保持兼容。`bodyReadFailed` 是单向标志——它记的是**已证明**的损坏,后到的显式错误帧覆盖 code/message 也清不掉它;`canRetryZeroWorkRejection` 据此只放行「无损坏 + 零计费工作」的显式拒绝去重试,**损坏的 body 不可伪装成空流**来蹭重试预算。

### 帧边界 EOF

上游偶发生成中途干净断流,EOF 恰落在帧边界——`assertComplete()` 无半帧可查、HTTP 正常收尾,旧实现于是发 `end_turn`;真实 Claude Code 2.1.263 把半句话当任务完成,12 步做 4 步就 `exit 0`、`is_error:false`,后续两轮也不会补(2026-09-07 修复前后各实跑一次对照)。可判信号只有一个:352 条真实响应帧审计 351 条以 `metadataEvent → contextUsageEvent → meteringEvent` 收尾(Claude 与 GPT-5.6 皆然),唯一缺它的恰是 reasoning 中途 EOF;2026-09-08 两款 CLI 的真实长链会话又录到 376 条,372 条带尾帧,缺的 4 条全是真实故障或客户端断连(`ECONNRESET` / 上游 `Exception` 帧 / 探针超时掐断),**没有一条是干净完成**,即零误判。**kiro-cli 2.21.1 自己不做这个判定**(`PROBE_STREAM_SHAPE=text-eof` 实测:只发正文就 EOF 它照样 `exit 0` 打印半句、不重试,只少一行 Credits),网关有意比官方客户端严格——Claude Code / Codex 对 `max_tokens`/`incomplete` 会续接,对 `end_turn` 只会当任务完成。故解码层把它从 Unknown 提升为已知事件,两条归约同源:**有内容 + 无错误 + 无尾帧 → `max_tokens`**(Responses → `incomplete`/`max_output_tokens`)。三条红线:① 只取「出现过」,**不用它的 `stopReason`**(带工具的响应里 124/325 报 END_TURN,终态仍由网关推断);② 零内容不进这里(仍归判空 + 有界重试),显式错误帧与读流损坏走 in-band error,网关自伤降 info;③ 已完成的 tool_use 无尾帧也报 `max_tokens` 而非 `tool_use`——后面可能还有没到的兄弟调用。`stream completed` / `openai stream completed` 日志的 `stop_reason` 必须取终结段**之后**的值(曾出现 wire 发 `max_tokens`、日志记 `tool_use`)。测试 fixture 里的「正常完成」**必须**带 `buildMetadataFrame()`(`framesWithMetering` 已含),不带 = 在测截断;手工服务器统一走 `test/helpers/event-stream.ts` 的 `completedFrames()`(两个 `codex-subagent-*-server.ts` 曾漏掉尾帧:Codex 对每条回复 `max_output_tokens` 重连 5 次后 `turn.failed`,整套矩阵假阴性)。真实 CLI 复跑 `conversation-fault-server.ts` + `claude-conversation-probe.mjs`(`K2C_PROBE_SCENARIOS=text-eof-once`)。

## 多模型 · GPT · OpenAI · Codex

### GPT 完全相同上游

请求体逐字段相同,唯一差异 `modelId`——支持 GPT = `mapModel` 加分支即两端可用,无需新上游适配。响应侧唯一真差异:GPT reasoning 走**同名** `reasoningContentEvent`,payload `{redactedContent}`(加密、无 text/signature)。**「见过原生帧」与「原生帧有内容可 surface」是两件事,`processReasoningContent` 必须分开记**:前者(含空/redacted 帧)决定锁 native 模式、关掉 legacy decoder,后者才决定开 thinking content block。合并是二选一的错——只留后者则 redacted 帧不锁模式,GPT 可见输出里的字面 `<thinking>` 会被 legacy 解码剥走;只留前者则开一个永远空的 thinking 块。`metadataEvent{stopReason}` 故意落 `Unknown` 由网关推断(工具调用时 `tool_use` 比上游 `END_TURN` 准)。

### OpenAI prompt_tokens

`buildClaudeUsagePayload` 会应用 derived 插件的 `input_tokens` 覆写(缓存拆分语义),而 OpenAI `prompt_tokens` 是**输入总量(含缓存)**。故 `openai/` usage 必须直接读 reducer 原始 `contextInputTokens ?? inputTokens` 与 `outputTokens`、绕过 `buildClaudeUsagePayload`;计费 hook 仍跑,只出标准三字段、不含 `kiro_*` 扩展。

### Codex 只说 Responses

`wire_api=chat` 在 Codex 0.122+ 移除,必须走 `/openai/v1/responses`(请求 `input` items + 扁平 tools,响应严格语义事件序列)。编码器红线全在 `openai/responses/response-stream.ts` 头注释(`content_part.added` 先于 `output_text.delta`、done 回填全文、纯工具调用不产空 message、thinking → reasoning summary 惰性开),改编码器前先跑真实 Codex(`tools/codex/`)。

### Codex code mode

跨版本实测一致(版本号见 `tools/codex/README.md`):Codex 按模型名走**两套请求形态**。**认识**的名字(`gpt-5.6-sol`)→ code mode:顶层 `tools` 与 `instructions` **双双不存在**,工具改由 `input[0]` 的 `{type:"additional_tools"}` item 携带,含 `type:"custom"` 的 freeform 工具;**不认识**的名字(`gpt-5-codex`/`o3`/`sol`)→ 打 `Model metadata not found` 后 fallback 到标准顶层 `tools`。判别只看**字段在不在**,别按模型名分支;两套形态都要继续支持,真实抓包 fixture 在 `test/fixtures/responses/codex-code-mode-request.json`(扁平)+ `codex-code-mode-namespaced-request.json`(namespace 嵌套)。code mode 下**所有真实工具(`apply_patch`、`exec_command`)都不是独立 tool**,只写在 `exec` 的 description 里,模型必须调 `exec` 传 JS(`await tools.apply_patch(...)`)。

freeform 工具上游无通道 → 包成单 `input` 字符串字段的 JSON 工具(`FREEFORM_TOOL_SCHEMA`),**必须同时追加适配说明**(原描述明写 "not JSON",不说明则模型吐裸文本);工具名经 `customToolNames` 传到响应侧还原 `custom_tool_call`,漏传即错编成 `function_call`。流式**不能边收边发**:手里是 partial JSON,须缓冲到 block 结束解出 `input` 再一次性发。替身编解码的单一真相源是 `openai/freeform-tool.ts`。chat 端点**刻意**未实现 custom 工具:Chat Completions 规范同样有 `type:"custom"`(嵌套在 `custom` 下),但已知无客户端(Codex 0.122+ 只说 Responses、无法端到端验证);codec 放在 `openai/` 而非 `openai/responses/`,将来要接只需加一层 wire 形状适配。

**新版 Codex 把工具再折进一层 `functions` namespace 容器,只展开这一个**:漏展开的症状 = 零工具上送、模型永远不调工具;为何只认这个名字、为何非递归、**`collaboration`(subagent 六个工具)展开后为何必须同时写回 `namespace` 字段**(2026-09-07:漏写 = `unsupported call`、模型无限重试,实测单轮 110+ 次计费请求;曾误判为「网关侧无解」),全在 `expandNamespaces` 头注释。

**multi-agent v2 的线程间信封 `agent_message` 三类都必须转**(`convertAgentMessage`):`NEW_TASK` 丢 → 子线程空 Payload;`MESSAGE`(`send_message` 的子 → 父中间消息)丢正文 → 父线程只见空 `Payload:`、误读成简短确认(2026-09-08:spawn/NEW_TASK/FINAL_ANSWER 全绿,只有它丢,固定 nonce 端到端返回 `EMPTY` 才看得出);`FINAL_ANSWER` 丢 → 父线程看不到子 agent 的答案(**最隐蔽**:`wait_agent` 的工具结果只有 `Wait completed.`、不含答案,丢了它链路全绿却在空手总结)。判据分两层见该函数头注释(白名单常量 `PLAINTEXT_BODY_MESSAGE_TYPES`,扩名单先抓脱敏 fixture);生命周期矩阵(并发不串线 / followup / interrupt / timeout / fork_turns / 故障重试不重复 spawn / `message` 正文入口,8/8)见 `tools/codex/README.md` + `test/manual/codex-subagent-{probe,lifecycle}-server.ts`。

### Messages hosted WebSearch

`websearch.ts` 的同一 Message 同时生成 JSON 与 SSE,遵守请求 `stream`;`web_search_tool_result.tool_use_id` 必须引用同次 `server_tool_use.id`。多轮请求读取最后一条 user query,不能反复搜首轮。MCP 错误、`isError` 和损坏结果按错误状态返回,429 保留 Retry-After,只有显式 `results:[]` 才算成功的零结果。普通 client function 即使同名 `web_search` 也不能被 MCP 旁路劫持。

### Codex 侧无法用 web search

code mode 的 `additional_tools` 里**没有** `web_search`(`tools.web_search=true` 等三种配置均无效),fallback 形态倒是发 `{"type":"web_search"}`,但那是 hosted(服务端执行)工具、无 `parameters`,上游给不了。网关自带的 `claude/websearch.ts`(走 Kiro MCP)只处理 Messages 中「单个、名为 `web_search`、带日期版 hosted type」的工具——那是 Claude Code 的独立子请求路径,Codex 把它混在工具集里走不通。实测 Codex **接受**网关产的 `web_search_call` item(渲染成 `web search: <query>`),故要支持是可行的,但需新功能(注入工具 + 网关自己执行 MCP 搜索 + 产 item),不是转发能解决的。

### GPT credit 锚定

GPT 侧 `(input, visibleOut, credits)` 欠定——Kiro 不传导 GPT 缓存折扣(`cache_read`/`cache_creation` 恒 0、input 全量计入),且 output 含加密 reasoning(计费不 surface),无法反解「公开价等效成本」。故唯一可靠真值 `credits×0.04`(× multiplier),走 `deriveKiroUsage` 顶部 `isGptModel` 专属分支(status `gpt_credit_anchored`)。**绝不给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**:偏高 credits 会被标准反演误推成虚高 `tEffIn` → 把 input 误拆成 `cache_creation`(分流必须在价格表查询**前**)。红线在 `gptCreditAnchoredBreakdown` 头注释。

## 错误流转 · 容量事件诊断

### 跨模型对照

曾有一批下游 502 **全部**来自上游 5xx、网关自身零错误。判别顺序(每步独立否掉一批假设):① **同容器跨模型**——同容器同时段某模型大面积失败、另一模型零失败,只 `modelId` 变 → 上游**按模型**容量短缺,一击定案(info 级日志无模型字段,`mapped_model` 只在 `debug`,要开 debug / 用 metering 记账 / 客户端侧分桶);② **分钟级时间轴**——失败集中在十几分钟窗口、窗口后流量更高却不失败 → 是事件非长期状态;③ **请求形状对照**(`max_tokens`/`tool_count`/`system_length` 分布相同)→ 非 converter 构造错;④ region/profileArn/`tier` 全同 → 非路由或配额档。**别按主机/账号先分桶**(同机同分钟有账号全挂也有毫发无伤,会误推「账号被封」)。**有界重试对此无效**(上游恢复远慢于请求内重试),空流有界重试的思路不能照搬 5xx;有效缓解是**切模型**。日志用 `capacity_reason` 结构化字段区分,别靠 substring 匹配 `error`。

### 容量不足的 5xx 为何是 503 而非 502

「压成 502」是给**未知**失败态的默认值,而 `MODEL_TEMPORARILY_UNAVAILABLE` / `INSUFFICIENT_MODEL_CAPACITY` 是已知态——同一件事上游还会用 429 和 mid-stream `ThrottlingException` 表达,那两条早就是可重试信号(429 / 503),只有这条曾掉进 502 让容量事件看着像网关自己坏了。施加点在 `retry-executor.ts` 的 5xx 分支而非 `classifyErrorBody`:后者跑在 429 分支**之前**(会把更具体的 429 劫持成 503)且拿不到 header(丢 Retry-After)。只作用于 5xx——429 保持 `rate_limited`、408 保持透传,两条都有反向守卫。下游三元组复用 `upstreamErrorWire(true)`,与 mid-stream 容量信号同一份定义。判别子 / 判别顺序 / 为何不透传 504 / 为何绝不自己编 Retry-After,全在 `matchModelCapacityReason()` 与 `MODEL_CAPACITY_REASONS` 的头注释(`kiro/provider-error.ts`)。反过来,402 配额判定(`isMonthlyRequestLimitBody`)故意是宽松全文扫描,不套用「先读声明的 reason」——两者代价不对称:漏判配额 = 400「请检查请求体」(错且不可重试),而容量侧的产物是日志维度,一个似是而非的 token 比没有更糟。别统一这两个函数(反向守卫在 `test/kiro/provider-error.test.ts`)。

## 日志四条守卫的理由

部署形态是多容器同机 + 高频健康检查,日志既是排障依据也是磁盘成本。

- **每请求只打一行**:Fastify 内置请求日志与 `index.ts` 的 `onResponse` hook 并存会每请求三行、其中两行都叫 `request completed`——不只是体积,按 incoming/completed 配对做的分析会稳定算错。
- **业务字段一律 snake_case**:混用会逼运维为同一指标查两种拼写。
- **一个指标只有一个 owner**:`capacity_reason` 是上游容量事件的唯一计数维度,而同一件事有 429 / 5xx 两种线格式;mapper 手里也有 `err.kind.reason`、顺手再记一次就让 5xx 形态权重翻倍,只记 5xx 分支又漏掉更常见的 429。
- **网关自己造成的结果不记 `error`**:主动 `destroy()` socket、主动 abort 上游后读流抛错,都是那一行代码的必然结果而非上游故障。记成 error 会污染告警,且让人误判「上游在报错」(实测假 error 与自毁动作 1:1)。

## 上游与客户端的实测事实

### kiro-cli 自己怎么处理 5xx / 429 / 400

2.21.1 实测(`kiro-cli-probe.ts` 注入状态码):**500/502/503 → 共 9 次**(SDK 内层 attempt 1→2→3,带抖动退避 ~150–1800ms;应用层外层再来 3 轮,间隔 ~2.1s→4.6s);**429 → 3 次**,不走内层重试(attempt 恒为 1),间隔**严格等于 `Retry-After`**(实测 7007/7009ms);**400 → 不重试**。网关**一次都不重试**、原样透传(架构决策见 `retry-executor.ts` 头注释 + 「跨模型对照」)——即 kiro-cli 有 9 次机会而网关只有 1 次,瞬时 5xx 上二者体感差距全在于此。

### 重试头的三个调用点

`applyRetryHeaders`(`kiro/retry-executor.ts`)是 `amz-sdk-invocation-id` / `amz-sdk-request` / `x-kiro-attempt` wire 格式的唯一 owner(`attempt=N; max=M` 拼法、第 2 次起才有的 `ttl=`、`x-kiro-attempt` 的无空格分隔),含 2.21.1 抓包形态。三个调用点的差异只走参数:executor(默认 `max=3`+Kiro 头)、OIDC refresh(`max=4`,另一个服务)、`getUsageLimits`(`max=1`,无抓包证据故不发 Kiro 头)。后两者**故意**不接 `RetryExecutor`:它抛 `ProviderError`,而 `/kiro/usage` 与 plugin capability 都按 `KiroHttpError` 分流(`routes/kiro.ts` `translateUsageError`),且 executor 的 body 分类器是按 messages 端点的错误体设计的——要统一得连错误语义一起迁。抓包侧同名清单 = `scripts/capture-kiro-cli.sh` 的 `RETRY_HEADERS`(剔出 fixture,免得抓包时点决定字段值)。**别搬回** `provider.ts` 的 `buildHeaders`:那里每次调用生成新 uuid,上游看到的每次重试都成了「attempt=1 的全新请求」。一次 `execute()` = 一次逻辑调用(共用 invocation-id、attempt 递增),空流重试每次重走 `execute()` = kiro-cli 的**外层**重试(换新 id、attempt 归 1)。

### web_search / web_fetch 分别在哪执行

2.21.1 实测:`web_search` → **走上游 `InvokeMCP`**(`x-amz-target: AmazonCodeWhispererStreamingService.InvokeMCP`,body 是 JSON-RPC `tools/call` + `{name:'web_search',arguments:{query}}`,带 `x-amzn-kiro-profile-arn` 头),所以网关代为执行是对的(`claude/websearch.ts`);`web_fetch` → **零上游请求**,客户端本地直接抓——是客户端职责,网关不该实现。kiro-cli 把两者都当普通工具上送给模型;网关只旁路「单个、名为 `web_search` 且 type 为 `web_search_YYYYMMDD` 的 hosted 工具」。Claude Code 2.1.263 的实际独立子请求为 `web_search_20250305`,普通同名 function 必须仍交客户端执行。

### 工具调用往返与图片的 wire 形态

2.21.1 实测:assistant 侧 `{messageId, content, toolUses:[{toolUseId,name,input}]}`(`input` 是**对象**;`messageId` 是**客户端生成的 UUID v4**,且只在带 toolUses 的那条上出现 → 唯一设置点 `attachToolUses`,见 `model/requests/conversation.ts`)。user 侧 `toolResults:[{toolUseId, content:[{text}|{json}], status:"success"|"error"}]`。`status` 表示**工具本身是否执行成功**,不是业务结果——`exit 42` 仍是 `success`。与本项目的两处已知差异(`isError` 我们多发、`{json}` 通道我们不产)及各自的不动理由,全在 `ToolResult` 头注释(`model/requests/tool.ts`)。图片经 tool_result 回传时(`fs_read` 的 `Image` mode)**提升到 message-level `images: [{format:'png', source:{bytes:<base64>}}]`**,`toolResults[].content` 原位只留占位文本 `"See images data supplied"`;项目的提升逻辑一致,仅占位文案不同(`[image attached to this message]`),实测两者上游都收。`toolResults[].content` 塞 `{image}` 上游 200 但静默丢弃(2026-09-09 直连实测),wire 没有结构化图片通道。

### Responses 的字节量约为 Claude 的 10×

同一段内容实测:Claude 15KB/118 事件 vs Responses 155KB/906 事件。**不是丢包也不是编码 bug**,拆开是两项:上游 GPT 的 delta 分片更碎(事件数 ~7.7×)+ Responses 每事件字段更多(`item_id`/`output_index`/`content_index`/`sequence_number`,每事件 171B vs 131B,~1.3×)。运维含义:同样内容 Responses 更吃带宽与写缓冲,背压也更早出现(慢读实测 26.6s vs 13.1s)。

### 客户端报 InputValidationError 怎么查

先看网关日志有没有 `upstream truncated tool_use (no isComplete frame)`——它只说明上游截断过,**不再意味着客户端会收到残缺调用**:未完成的调用已被缓冲在网关内、从不上 wire。故若仍报 `JSON parse failed`,那是**新**问题(参数在网关侧就该解析失败并报协议错误),别当成同一条。其余两支在客户端侧:`ZOD_VALIDATION`(超 `questions≤4`/`options≤4`/`header≤12` 或违反「问题文本与同题内 option label 须唯一」的跨字段 refine,后两条 JSON Schema 里表达不出、模型看不到)、`PERMISSION_UPDATED_INPUT`。

### 支持哪些模型 / 加模型要同改的地方

`claude/models-catalog.ts` + `mapModel()`。**加 GPT 变体六处同改**:mapModel / MODELS_WITH_NATIVE_REASONING / getContextWindowSize / claude+openai catalog / plugin-derived `isGptModel`(跨包复制的变体 token sol·terra·luna·codex);**加 Opus 5 同改**:mapModel / MODELS_WITH_NATIVE_REASONING / getContextWindowSize / claude catalog / request-validator `isAdaptiveOpus` / plugin-derived price+threshold——上游 modelId `claude-opus-5` **无小数点**,判别子须避 `4-5`;openai catalog 自动继承。
