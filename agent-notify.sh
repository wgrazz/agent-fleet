#!/bin/sh
# Ping the owner's Discord agent channel. Usage: agent-notify.sh "<message>"
# Never fails the caller: a missing webhook or a failed post only warns.
[ -n "$DISCORD_AGENT_WEBHOOK" ] || { echo "agent-notify: DISCORD_AGENT_WEBHOOK unset, skipped" >&2; exit 0; }
msg="[${AGENT_NAME:-agent} @ $(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")] $*"
python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:2000]}))' "$msg" |
  curl -sf -H 'Content-Type: application/json' -d @- "$DISCORD_AGENT_WEBHOOK" >/dev/null ||
  echo "agent-notify: post failed" >&2
exit 0
