FROM node:24-bookworm

ARG CODEX_VERSION=latest

# @openai/codex 是 OpenAI 官方 Codex CLI(Rust 二进制,npm 分发)。build 时把实际
# 拉到的版本号落地到 /etc/codex-version(事后唯一可信版本来源)。
RUN npm install -g @openai/codex@${CODEX_VERSION} \
 && (codex --version > /etc/codex-version 2>&1 || echo unknown > /etc/codex-version)

RUN useradd -m -s /bin/bash coder
USER coder
WORKDIR /home/coder

RUN mkdir -p /home/coder/.codex

COPY --chown=coder:coder entrypoint.sh /home/coder/entrypoint.sh

ENTRYPOINT ["/home/coder/entrypoint.sh"]
