#!/bin/bash
set -e

# 运行时从环境变量生成 ~/.codex/config.toml,把 Codex 指向 kiro2claude 网关的
# OpenAI **Responses API** 端点(wire_api=responses;Codex 0.122+ 只支持 responses)。
#
# model 默认 `gpt-5.6-sol`(真名,无需别名)。★ Codex 按模型名走**两套请求形态**:
#   - **认识**的名字(gpt-5.6-sol)→ code mode:顶层 tools/instructions 消失,工具
#     改由 input 的 `additional_tools` item 携带,含 type:"custom" 的 freeform
#     `exec`(所有真实工具如 apply_patch/exec_command 都藏在它的描述里)。
#   - **不认识**的名字(gpt-5-codex / o3 / sol …)→ 打印 "Model metadata not found"
#     并 fallback 到标准顶层 tools(10 个 function/namespace/web_search)。
# 网关两套都支持(见 core/src/openai/responses/converter.ts),所以直接用真名即可。

CONFIG="$HOME/.codex/config.toml"
: "${CODEX_MODEL:=gpt-5.6-sol}"
: "${KIRO2CLAUDE_BASE_URL:=http://host.docker.internal:8080/openai/v1}"

cat > "$CONFIG" <<EOF
model = "${CODEX_MODEL}"
model_provider = "kiro2claude"
# 容器内沙箱:全放开(容器本身即隔离,避免 landlock/seatbelt 在 Docker 里的兼容问题)
sandbox_mode = "danger-full-access"
approval_policy = "never"

[model_providers.kiro2claude]
name = "kiro2claude"
base_url = "${KIRO2CLAUDE_BASE_URL}"
env_key = "KIRO2CLAUDE_API_KEY"
wire_api = "responses"
EOF

exec codex "$@"
