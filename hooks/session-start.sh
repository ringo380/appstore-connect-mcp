#!/usr/bin/env bash
set -u

# Exit silently if credentials are already configured (env var or ~/.zshenv)
if [ -n "${APP_STORE_KEY_ID:-}" ] || grep -q 'APP_STORE_KEY_ID' "${HOME}/.zshenv" 2>/dev/null; then
  exit 0
fi

# Credentials missing — inject setup reminder into session context
context="App Store Connect MCP is installed but credentials are not configured. Run \/appstore-connect-mcp:setup to provide your API Key ID, Issuer ID, and .p8 file path."

printf '{\n  "hookSpecificOutput": {\n    "hookEventName": "SessionStart",\n    "additionalContext": "%s"\n  }\n}\n' "$context"
exit 0
