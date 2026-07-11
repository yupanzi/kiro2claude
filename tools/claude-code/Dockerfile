FROM node:24-bookworm

ARG CLAUDE_CODE_VERSION=latest

RUN useradd -m -s /bin/bash claude

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && node -p "require('$(npm root -g)/@anthropic-ai/claude-code/package.json').version" > /etc/cc-version

USER claude
WORKDIR /home/claude

RUN mkdir -p /home/claude/.claude

COPY --chown=claude:claude claude-settings.json /home/claude/.claude/settings.json
COPY --chown=claude:claude entrypoint.sh /home/claude/entrypoint.sh

ENTRYPOINT ["/home/claude/entrypoint.sh"]
