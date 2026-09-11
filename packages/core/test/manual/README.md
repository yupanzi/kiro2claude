# 手工探针与检测器

非 CI、vitest 不收。标 💰 的打真实上游会计费,其余零上游。默认测试模型统一 `claude-opus-5`(读 `_harness.mjs` 的 `CLAUDE_MODEL`)。跑完打真实上游或起本地服务器的脚本要 `pkill` 掉 tsx 子进程,kill pnpm 包装进程杀不掉它,旧代码会继续占端口。

| 脚本 | 用途 |
|---|---|
| `_harness.mjs` | 所有脚本共用:env / 发请求 / 解 SSE / 号段校验 / **两套协议不变量** / 汇总退出码。新脚本从这里拿,别各写一份缩水的不变量集 |
| `kiro-cli-probe.ts` | 反向驱动真实 kiro-cli:伪造 event-stream 让它执行工具、注入错误码看重试策略、`PROBE_STREAM_SHAPE=text-eof` 看它对无尾帧 EOF 的处理 |
| `protocol-integrity.mjs` / `backpressure-integrity.mjs` / `concurrency-integrity.mjs` | 流式完整性三件套:确定性序列 + 协议不变量(block start/stop 配对、`message_delta` 恰一次、Responses `sequence_number` 无洞、done 回填 == delta 累积)/ 慢客户端背压下终结段是否完整 / 并发号段隔离(混入外区间数字即串扰) |
| `opus5-effort-matrix.mjs` 💰 / `gpt-tool-matrix.mjs` 💰 | 手工点验矩阵:Opus 5 走 Messages(effort × tools/images/search);GPT 工具往返(effort × 协议 × 流/非流,可选图片)。不重试,失败原样留在报告里(`K2C_REPORT_DIR`) |
| `conversation-fault-server.ts` | 会话完整性故障服务器:真实网关转换/传输 + 脚本化上游,只按历史里的工具回执推进、按场景注入故障(`text-eof-once` 等);`live-*` 场景经 `_live-conversation-provider.ts` 打真实上游 💰 |
| `claude-conversation-probe.mjs` / `codex-conversation-probe.mjs` | 真实 CLI 三轮持久会话 + Docker 工作区文件任务,独立验收(`_conversation-workspace.mjs`) |
| `empty-cli-server.ts` + `claude-empty-probe.mjs` / `codex-empty-probe.mjs` | 空响应 9 场景 × 两款真实 CLI |
| `live-coding-conversation.mjs` 💰 / `codex-live-coding-conversation.mjs` 💰 | 真实模型三轮编码会话;预算默认 65 次上游调用,`K2C_LIVE_MAX_CALLS` 可放宽(opus-5 三阶段 ~75+、Codex ~46);oracle `_live-coding-workspace.mjs`,服务器即 `conversation-fault-server.ts`(`K2C_CONVERSATION_PORT=18943`) |
| `claude-unicode-input-probe.mjs` | 客户端侧 Unicode 转义改写复现(本地假 Anthropic 服务);结论见 README「已知限制」 |
| `multi-image-attribution-probe.mjs` 💰 / `multi-image-cli-probe.mjs` | 多图归属:API 直打(反序回执 / 交错标签 / 相同图计数)/ Docker 真 CLI 读 N 张数字图按文件判分,错误分归属错位 / OCR 误读 |
| `replay-conversation-history.ts` / `audit-conversation-fixes.mjs` | 不调模型:重放录得请求验证历史保留 / 审计探针产物 |
| `replay-content-preservation.ts` | 不调模型:录得的 5923 条真实 Claude Code 请求过一遍**当前** convertRequest,核对客户端文本是否上 wire、`role:system` 插入落点、history 形态。**改 converter 必跑** |
| `inserted-content-live.mjs` 💰 | 中途插入内容的 7 种客户端形态各埋一个 nonce 打真实上游,看回复是否含 nonce |
| `codex-subagent-{probe,lifecycle}-server.ts` | Codex multi-agent v2 信封与生命周期矩阵;见 `docs/PITFALLS.md`「Codex code mode」 |
