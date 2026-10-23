# Fleet Dashboard: design

Date: 2026-10-23 · Status: approved design, not yet built

## What it is

A personal dashboard for the coding agents running on one Mac. It runs locally, opens in a
browser, and installs on an iPhone as a home-screen app over Tailscale. It shows every agent
and its status at a glance. You can answer, pause, resume and start agents from it, sort them
into folders, browse and resume past conversations, and keep idea checklists that turn into
agents in one tap. A voice assistant ("Jarvis") comes later as phase 4 and has its own design.

Single user. It is not a hosted service and has no accounts.

## Decisions

| Topic | Decision |
| --- | --- |
| Where it opens | Browser on the Mac + iPhone home-screen web app over Tailscale |
| Answering agents | Reply box with quick-reply buttons by default; full in-page terminal on demand |
| Grouping | Manual folders (create, rename, recolor, delete, drag agents in). Agents all start at a monorepo root, so folder-by-directory is useless |
| Which conversations | Running agents + all past Claude and Codex sessions (History), resumable |
| Tools | Claude (`claude`), Codex (`codex`), Cursor (`cursor-agent`/`agent`), Antigravity (`agy`), GitHub Copilot (`copilot`). Adding one is one table entry |
| New agent | Quick start (default profile), saved profiles, or a custom form: name, tool, model, effort, folder, first prompt |
| Alerts | Web push to the phone + dashboard badge, on: needs you, done, crashed |
| Layout | Three panes: sidebar (folders, Later, Library, meters) · agent list · agent view |
| Look | Mac native: system font, light with automatic dark mode, blue selection |
| Stack | TypeScript server + React page, in this repo |

## 1. Pieces

All in `agent-fleet`:

1. **`fleet` CLI (Python, existing).** Stays the source of truth and works without the server.
   New in this work:
   - `STATUS` column (needs you · working · done · crashed · paused)
   - `fleet new NAME [--tool T] [--profile P] [--folder F] ["first prompt"]`
   - `fleet pause NAME`, `fleet unpause NAME`
   - `fleet idea [-l LIST] "text"`
   - `fleet dash` (opens the dashboard)
   - `fleet hooks install` (adds the Claude Code hooks)
   - `fleet hook EVENT` (what the hooks call)
2. **Server (`dashboard/server`, TypeScript on Node).** Started at login by a `launchd` agent
   with KeepAlive. It reads tmux, receives hook events, detects status, sends web push,
   serves the API, WebSocket streams and the page, and owns `~/.fleet/fleet.db` (SQLite).
3. **Page (`dashboard/web`, React + Vite).** The three-pane UI. On a phone it becomes one pane
   at a time with a bottom tab bar (Agents · Later · History · Usage). It is a PWA so iOS
   allows push.

The monorepo that motivated this keeps `scripts/fleet` as a pointer to this repo's `fleet`, so
only one copy exists.

**Data dir `~/.fleet/`:** `fleet.db`, `config.json` (access key, default profile), VAPID keys,
logs. Never in the repo.

**Network and auth.** The server binds to `127.0.0.1` only. `tailscale serve` publishes it to
the tailnet over HTTPS, which iOS push requires. Every request needs the access key from
`config.json`. It is passed once as `?key=`, then held in a cookie. Devices on the same Wi-Fi
cannot reach it at all.

**Dependencies (kept small):** `ws`, `node-pty`, `@xterm/xterm`, `web-push`, `react`, `vite`.
SQLite uses Node's built-in `node:sqlite`.

## 2. Status detection

States: `working`, `needs_you`, `done`, `crashed`, `paused`. tmux is the truth for whether an
agent is alive. The DB stores only user data and paused-session records.

**Claude Code (exact, via hooks).** `fleet hooks install` adds these hooks, each of which
calls `fleet hook <event>`. The hook command reads the hook JSON from stdin, adds
`$TMUX_PANE`, and POSTs it to the server. If the server is down it exits 0 silently.

| Hook | State |
| --- | --- |
| `UserPromptSubmit`, `PreToolUse` | working |
| `Notification` | needs_you |
| `Stop` | done |
| `SessionEnd` | handed to crash/exit logic |

**Other tools (heuristic, by screen).** Every 2 s the server runs `tmux capture-pane` on each
agent pane and applies that tool's patterns from one table (`detectors.ts`):

- Screen changing, or a spinner glyph showing → working
- Numbered menu, `Allow`/`(y/n)`/approve prompt → needs_you
- Unchanged for ≥ 5 s at an empty input prompt → done

For Codex, the live rollout log is used where it is more reliable than the screen. Claude panes
also get screen detection, as a fallback for anything hooks miss.

**Crashes.** Sessions started by `fleet new` set `remain-on-exit on`. A dead pane with a
non-zero exit status, or an exit without a prior `done`, is crashed. The last screen and the
exit code are kept for display.

**Alerts** fire only on transitions into needs_you, done or crashed, once per transition.

## 3. Screens

**Sidebar**
- **New agent** button with a ▾ for profiles and "Custom…"
- **All agents**, with a needs-you badge
- **Folders:** right-click to rename, recolor or delete. Delete returns its agents to All
- **Later:** Paused, Ideas (with its lists)
- **Library:** History
- **Footer:** usage meters and Mac memory

**Agent list.** Grouped Needs you → Working → Done → Crashed. Each row has a tool avatar with
a status dot (pulsing while working), the name, the age, a one-line activity (task title or
the last line of the screen) and a folder chip.

**Agent view**
- **Header:** name, status pill, tool · model · effort, folder. Actions: Pause, Full terminal,
  ⋯ (rename, move, kill)
- **Chat | Terminal toggle.**
  - Chat renders the transcript as a clean conversation, for Claude
    (`~/.claude/projects/*/<session>.jsonl`) and Codex (rollout JSONL). It works for live and
    past sessions.
  - Terminal is the live screen, streamed over WebSocket.
- **Changes tab:** per repo the agent touched, the changed files (`git status`), its commits
  since start, and pushed or not.
- **Composer:** text box plus quick-reply buttons parsed from any on-screen numbered menu,
  plus Interrupt (Esc). Sending uses `tmux send-keys -l` and then Enter.
- **Full terminal:** xterm.js over a `node-pty` running `tmux attach -t =NAME`, so it is fully
  interactive.

**History.** Every past Claude and Codex session for the configured project roots. Search by
title and first prompt. Open in chat view, resume into a new tmux session, or drag into a
folder.

**Usage meters.** Per provider: the 5-hour and weekly windows, the percentage used and the
reset time. Claude and Codex are expected to be readable locally. Copilot, Cursor and
Antigravity are best effort. A provider that cannot be read shows "unknown", never a guessed
number.

**Keyboard (Mac)**

| Key | Action |
| --- | --- |
| ⌘K | Jump to an agent, conversation or idea |
| ↑ / ↓ | Move through the list |
| 1–9 | Quick replies |
| / | Focus the reply box |
| ⌘N | New agent |
| ⌘I | Capture an idea |

**New agent.** Quick start uses the default profile, an auto-generated name and no folder. A
profile is `{name, tool, model, effort, folder, extra args}` and is managed in the UI and
the DB. Launching an agent is `fleet new` underneath, so the CLI and the dashboard behave the
same.

**Pause / resume.** Pause stores `{tool, session id, cwd, folder, name}`, then stops the
agent. Resume runs the tool's own resume command in a new `fleet new` session:

| Tool | Resume command |
| --- | --- |
| Claude | `claude --resume <id>` |
| Codex | `codex resume <id>` |
| Cursor | `cursor-agent --resume <chatId>` |
| Copilot | its resume flag |

A tool with no resume support is moved to the Later shelf but keeps running.

## 4. Ideas

- **Lists:**
  - **Priority** is pinned at the top.
  - **Brain Dump** is the inbox and default capture target, with an unsorted count.
  - User lists follow in a user-set order. Lists can be created, renamed, recolored,
    reordered and archived.
- **Items** are checklist items with optional notes. Drag to reorder or move them across
  lists. Checked items fold into "Done (N)" and stay searchable.
- **Sort mode** (on Brain Dump) shows one item at a time with Claude's suggested list. The
  suggestions come from a batch `claude -p` call returning `{item id → list, confidence}`.

  | Key | Action |
  | --- | --- |
  | Enter | Accept the suggestion |
  | number | Send to a different list |
  | D | Delete |
  | A | Start as an agent |
  | S | Skip |

  On the phone, swipe right to accept and left to skip.
- **Recurring:** an item can repeat (weekly on a day, monthly on a date, every N days). Checking
  it schedules its return.
- **Item → agent:** pick a profile, and the item text becomes the first prompt. The item links
  to the agent and shows its live status dot. When the agent reaches done, the item offers
  "Mark done?".
- **Capture:** the dashboard (⌘I), the phone app, `fleet idea`, and Jarvis (phase 4).
- **Import (one-time):** from chosen Apple Notes checklist notes. The importer reads the Notes
  database directly so checked state is preserved, because AppleScript's note body drops it.
  Unchecked items become active items and checked items go to Done. Nothing syncs back.

## 5. Build order

Each phase is usable alone, gets its own implementation plan, and is committed and pushed
when done.

1. **Core:** CLI upgrades (status, profiles, pause, idea, hooks), server, agent list, live
   terminal, composer and quick replies, new agent, pause/resume, web push, Tailscale HTTPS,
   and the `launchd` agent.
2. **Organize:** folders, profiles UI, History, Chat view, Changes tab, usage meters, ⌘K.
3. **Ideas:** lists, sort mode, recurring items, item → agent, Notes import.
4. **Jarvis:** its own design first. Scope agreed so far:
   - Answer "what needs me?"
   - Act on agents by voice
   - Optional spoken alerts, off by default
   - Voice brain dump
   - Web questions through the Claude brain

   Input is the 🎙 button and ⌥Space. The pipeline is speech-to-text, then `claude -p` calling
   the server API, then text-to-speech.
5. **Maybe later:** calendar and reminders for Jarvis.

## Failure behavior

- **Server down:** the CLI is unaffected, and `launchd` restarts the server.
- **Push failure:** logged and ignored. The badge and card still show the state.
- **Hook POST failure:** silent exit 0, so a Claude session is never blocked by the dashboard.
- **Mac asleep:** the dashboard is unreachable while the Mac sleeps. `fleet new` keeps it
  awake only while the lid is open or the Mac is on external power.
- **Unreadable usage:** the meter shows "unknown".
- **Detection wrong:** the screen gets saved as a test fixture, then the detector table is
  fixed.

## Testing

- **Detector tests:** real `capture-pane` fixtures for each tool and state (working,
  needs_you, done, crashed). Fixtures grow from real misses.
- **End-to-end smoke:**
  1. A fake agent script in tmux prints a numbered menu.
  2. Assert the server reports `needs_you`.
  3. Answer it through the reply API.
  4. Assert the pane received the input.
  5. Pause and resume it.
- **CLI:** `fleet selftest` extends to cover status, profiles, pause and idea.

## To verify during build

- Antigravity (`agy`) and Copilot resume flags and session-id locations.
- Where Claude's and Codex's 5-hour and weekly usage can be read locally, and what Copilot,
  Cursor and Antigravity expose.
- Whether the Claude `Notification` hook fires for every input wait used in practice
  (permission prompts, questions, idle input), or whether screen detection must cover some.
