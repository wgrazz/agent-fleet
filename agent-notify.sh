#!/bin/sh
# Ping the owner: Fleet's phone push if the dashboard is up on this machine, else Discord.
# Usage: agent-notify.sh "<message>". Never fails the caller: a failed post only warns.
title="${AGENT_NAME:-agent} @ $(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
python3 - "$title" "$*" <<'EOF' 2>/dev/null && exit 0
import json, os, sys, urllib.request
cfg = json.load(open(os.path.join(os.environ.get('FLEET_DIR', os.path.expanduser('~/.fleet')), 'config.json')))
urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{cfg["port"]}/api/notify', method='POST',
    data=json.dumps({'title': sys.argv[1][:120], 'body': sys.argv[2][:2000]}).encode(),
    headers={'X-Fleet-Key': cfg['key'], 'Content-Type': 'application/json'}), timeout=3)
EOF
[ -n "$DISCORD_AGENT_WEBHOOK" ] || { echo "agent-notify: Fleet unreachable and DISCORD_AGENT_WEBHOOK unset, skipped" >&2; exit 0; }
python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:2000]}))' "[$title] $*" |
  curl -sf -H 'Content-Type: application/json' -d @- "$DISCORD_AGENT_WEBHOOK" >/dev/null ||
  echo "agent-notify: post failed" >&2
exit 0
