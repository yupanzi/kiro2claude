#!/bin/bash
set -e

# 运行时从环境变量生成 ~/.codex/config.toml,把 Codex 指向 kiro2claude 网关的
# OpenAI **Responses API** 端点(wire_api=responses;Codex 0.122+ 只支持 responses)。
#
# 关键:model 默认 `gpt-5-codex`——Codex 只对它**内部识别**的模型名下发工具集
# (实测 gpt-5.6-sol→0 工具 / gpt-5-codex→10 工具),网关 mapModel 再把
# `gpt-5-codex` 别名到真实的 gpt-5.6-sol。想要工具调用就保持这个名字。

CONFIG="$HOME/.codex/config.toml"
: "${CODEX_MODEL:=gpt-5-codex}"
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
