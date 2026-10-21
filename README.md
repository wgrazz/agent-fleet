# agent-fleet

See, reattach and stop every coding agent running on your machine — Claude Code, Codex,
Cursor — and keep them alive when the terminal (or your SSH session) drops.

```
$ fleet
   PID  TOOL            AGE  WHERE                         DIR             TASK
 41922  claude       2:14:07  safe · scraper · background   optimal         [running] Walmart gate C capability check
 43310  codex          31:50  dies with window              motion-studio   Trim the intro to 4 seconds
  + 3 background helpers (fleet all)

WAITERS
   PID  OWNER                  AGE  COMMAND
 42001  claude 41922       1:03:12  /bin/sh -c until ssh server 'test -f /tmp/done'; do sleep 300; done
```

## Why

Agents started in a plain terminal die when that window closes or a Termius / SSH connection
drops — along with the hour of work they were in the middle of. `fleet new NAME` starts a
protected tmux session (with `caffeinate` on macOS so the laptop doesn't sleep) and you run the
agent inside it. `fleet` then shows every agent on the box, whether it is protected, what it is
working on, and any follow-up waiters it armed. `fleet kill` cleans up.

## Install

```
git clone https://github.com/wgrazz/agent-fleet
ln -s "$PWD/agent-fleet/fleet" ~/.local/bin/fleet     # anywhere on PATH
```

Needs Python 3.8+, tmux, and `lsof`/`ps` (present on macOS and Linux). `caffeinate` is used
when present, so Linux works too; it just doesn't block sleep.

## Commands

| Command | What it does |
| --- | --- |
| `fleet new NAME` | Start a protected session called NAME in the current folder, then run `claude` / `codex` / `agent` inside it |
| `fleet resume [NAME]` | Reattach (no name: the only session, or a list) |
| `fleet peek NAME` | Print the last 40 lines of NAME's screen without attaching |
| `fleet` | Agents you started, what they're doing, and any waiters |
| `fleet all` | Same, plus background helpers (desktop apps, Codex service, chrome bridge, claude-mem) |
| `fleet kill PID\|NAME` | Stop one agent or waiter, or a whole session |
| `fleet kill --all` | Stop every agent and waiter you started, after a y/N prompt |
| `fleet selftest` | Offline check of the process-tree logic |

Inside a session: `Ctrl-b d` detaches (the agent keeps running), `Ctrl-b [` scrolls.

The TASK column reads Claude Code's session files (`~/.claude/sessions/<pid>.json` and the
transcript title) and Codex's thread database (`~/.codex/state_*.sqlite`). Cursor shows no task.

## agent-notify.sh

A nine-line companion: agents call it when a long job finishes, blocks, or gives up, so you get
a Discord ping instead of checking back.

```
export DISCORD_AGENT_WEBHOOK=https://discord.com/api/webhooks/...
AGENT_NAME=claude ./agent-notify.sh "Walmart gate C finished: 347 branches loaded"
# → [claude @ optimal] Walmart gate C finished: 347 branches loaded
```

It never fails the caller: a missing webhook or a failed post only warns on stderr.

## The long-wait pattern this supports

Tell your agents (in `AGENTS.md`) that when they start something that takes more than a few
minutes they should arm a follow-up — a background `until <check>; do sleep 300; done` loop
that re-wakes the session — say so in one line, and notify on result. `fleet` shows those
waiters under their owning agent, and `fleet new` is what lets them survive a dropped
connection. See [polyagent-kit](https://github.com/wgrazz/polyagent-kit) for the rule text.

## License

MIT
