#!/bin/bash
set -e

SETTINGS_FILE="$HOME/.claude/settings.json"
CLAUDE_JSON="$HOME/.claude.json"

# Generate settings.json from env vars at runtime
cat > "$SETTINGS_FILE" <<EOF
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "${ANTHROPIC_AUTH_TOKEN}",
    "ANTHROPIC_BASE_URL": "${ANTHROPIC_BASE_URL}",
    "DISABLE_INSTALLATION_CHECKS": "1",
    "API_TIMEOUT_MS": "3000000"
  }
}
EOF

# Pre-populate ~/.claude.json to skip interactive onboarding & trust prompts
# Resolve the actual working directory (handles mounted volumes)
WORK_DIR="$(pwd)"
cat > "$CLAUDE_JSON" <<EOF
{
  "hasCompletedOnboarding": true,
  "lastOnboardingVersion": "99.0.0",
  "numStartups": 1,
  "projects": {
    "${WORK_DIR}": {
      "hasTrustDialogAccepted": true,
      "hasCompletedProjectOnboarding": true,
      "allowedTools": []
    }
  }
}
EOF

exec claude "$@"
