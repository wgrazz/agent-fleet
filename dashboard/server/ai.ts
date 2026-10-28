// The dashboard's smart features, run through the Claude Code CLI on your own subscription (no API key):
// prompt improver, model recommender, Brain Dump sorter, interview prompt and Jarvis's brain.
// Calls skip your plugins, MCP servers and unused tools (--strict-mcp-config --setting-sources project --tools …),
// which measured ~14x cheaper than a default `claude -p`. Every call's cost is recorded in ai_usage.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AREAS } from '../web/src/areas.ts'
import { config, db, FLEET_DIR } from './store.ts'

const AI_DIR = join(FLEET_DIR, 'ai')
mkdirSync(AI_DIR, { recursive: true })
export const aiModel = () => process.env.FLEET_AI_MODEL ?? config.ai_model ?? 'sonnet'

type Schema = Record<string, unknown>
type AskOpts = { tools?: string[]; allow?: string[]; deny?: string[]; addDirs?: string[]; timeoutMs?: number; cwd?: string; feature?: string; resume?: string; persist?: boolean; model?: string; budgetUsd?: number }
export type Answer<T> = { value: T; session_id: string; cost: number }

export function askFull<T>(task: string, system: string, schema: Schema, opts: AskOpts = {}): Promise<Answer<T>> {
  const tools = opts.tools ?? []
  const args = ['-p', '--model', opts.model || aiModel(), '--output-format', 'json', '--strict-mcp-config', '--setting-sources', 'project',
    '--tools', tools.join(','), ...(tools.length ? ['--allowedTools', ...(opts.allow ?? tools)] : []),
    ...(opts.deny?.length ? ['--disallowedTools', ...opts.deny] : []), ...(opts.budgetUsd ? ['--max-budget-usd', String(opts.budgetUsd)] : []),
    ...(opts.addDirs ?? []).flatMap(d => ['--add-dir', d]),
    ...(opts.persist ? [] : ['--no-session-persistence']), ...(opts.resume ? ['--resume', opts.resume] : []),
    '--system-prompt', system, '--json-schema', JSON.stringify(schema), '--', task]
  return new Promise((resolve, reject) => {
    // FLEET_NO_WAIT: a `fleet mac` lookup Claude runs gives up fast on a permission prompt nobody has answered yet
    const child = execFile('claude', args, { cwd: opts.cwd ?? AI_DIR, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 << 20, env: { ...process.env, FLEET_NO_WAIT: '1' } }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(err.killed ? 'Claude took too long' : `claude failed: ${err.message.split('\n')[0]}`))
      try {
        const out = JSON.parse(stdout)
        const u = out.usage ?? {}
        db.prepare('INSERT INTO ai_usage (at, feature, cost_usd, input_tokens, output_tokens, cache_read, cache_write, persisted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(Math.floor(Date.now() / 1000), opts.feature ?? 'other', Number(out.total_cost_usd) || 0, u.input_tokens ?? 0, u.output_tokens ?? 0,
            u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0, opts.persist ? 1 : 0)
        if (out.is_error || !out.structured_output) return reject(new Error(out.result || 'Claude returned no answer'))
        resolve({ value: out.structured_output as T, session_id: out.session_id ?? '', cost: Number(out.total_cost_usd) || 0 })
      } catch {
        reject(new Error('could not read Claude’s answer'))
      }
    })
    child.stdin?.end() // left open, `claude -p` waits 3 s for piped input on every call
  })
}

export const ask = <T,>(task: string, system: string, schema: Schema, opts: AskOpts = {}) =>
  askFull<T>(task, system, schema, opts).then(a => a.value)

const obj = (properties: Schema, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false })
const str = { type: 'string' }

// ---------- prompt improver ----------

const IMPROVE_SYSTEM = `You rewrite a developer's task prompt so a coding agent (Claude Code, Codex, Cursor and similar) does the job well on the first try. The developer typed it quickly, often by voice, so expect typos and run-on sentences.

Write the improved prompt the way Anthropic recommends prompting current models:
- Lead with the goal and why it matters, then the context the agent needs: which project or files, what exists today, what's broken or wanted. Keep every concrete detail from the original (names, paths, errors, numbers, examples).
- Say what done looks like and how the agent can check it (a test to run, a page to load, a command whose output should change).
- State real constraints plainly with their reason, as positive instructions. Use normal volume: no capitals for emphasis, no "IMPORTANT", no "think step by step", no generic virtues like "be thorough".
- Describe outcomes rather than scripting steps; keep an ordered list only where order truly matters.
- Keep it as short as the task allows. A one-line fix stays a few lines.
- Never invent facts, files or requirements. If something essential is ambiguous, keep the prompt workable and list the open question in "questions".

Write in the developer's voice, addressed to the agent. Fix spelling. Don't add a role line ("You are an expert…").`

export type Improved = { prompt: string; changes: string[]; questions: string[] }

/** With a project folder, the improver may glance at its files (read-only) so names and paths in the prompt are real. */
export const improvePrompt = (text: string, project = '') =>
  ask<Improved>(`${project ? `The agent will run in ${project}. You may look around it briefly (a few reads or searches) to get file names, paths and commands right; don't try to solve the task.\n\n` : ''}Prompt to improve:\n<prompt>\n${text}\n</prompt>`, IMPROVE_SYSTEM,
    obj({ prompt: str, changes: { type: 'array', items: str }, questions: { type: 'array', items: str } }),
    project ? { cwd: project, tools: ['Read', 'Glob', 'Grep'], timeoutMs: 150_000, feature: 'improve' } : { feature: 'improve' })

// ---------- model recommender ----------

const CATALOG = `Tools and models available on this machine (tool name → models):
- claude (Claude Code, Anthropic subscription): fable (Claude Fable 5.1, most capable, best for the hardest long-horizon reasoning and big refactors; slowest and uses limits fastest), opus (Claude Opus 5.5, strong default for complex coding and agentic work), sonnet (Claude Sonnet 5.5, fast and capable for everyday coding, UI work, scripts), haiku (Claude Haiku 5.5, quick small edits, lookups, summaries). Effort: low | medium | high | xhigh | max (xhigh suits most serious coding; low for trivial tasks).
- codex (OpenAI Codex CLI, ChatGPT Plus): gpt-6-astra (default; strong at coding, good second opinion, separate limits from Claude). Effort: low | medium | high.
- cursor (Cursor Agent): auto, composer-2.5 (fast edits), gpt-5.3-codex / gpt-5.3-codex-high, claude-opus-5-thinking-high, claude-sonnet-5-thinking-high, gpt-5.6-sol-high, gemini-3.7-flash-high, grok-4.7-medium. No effort setting (it's in the model name).
- copilot (GitHub Copilot CLI, 200 premium requests a month): auto, gpt-5.6-luna, mai-code-1.1-flash. Effort: low | medium | high.
- agy (Google Antigravity CLI): Gemini 3.8 Flash (fast, cheap, good for quick tasks and research). Effort: low | medium | high.`

const ROUTE_SYSTEM = `You pick the best coding agent, model and effort for a developer's task, from the tools installed on their machine. Weigh the task's difficulty and kind (deep debugging, large refactor, UI polish, quick edit, research, writing), speed, and how much of each subscription is left: avoid a provider whose limits are nearly used up unless the task truly needs it, and prefer spreading work across subscriptions. Pick a real model from the catalog. Keep "why" to one or two plain sentences a non-expert would follow. Give one alternative.

${CATALOG}`

export type Route = { tool: string; model: string; effort: string; why: string; alternative: { tool: string; model: string; why: string } }

export const recommend = (task: string, usage: string) =>
  ask<Route>(`Current subscription usage:\n${usage}\n\nTask:\n<task>\n${task}\n</task>`, ROUTE_SYSTEM,
    obj({
      tool: { type: 'string', enum: ['claude', 'codex', 'cursor', 'copilot', 'agy'] }, model: str, effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
      why: str, alternative: obj({ tool: { type: 'string', enum: ['claude', 'codex', 'cursor', 'copilot', 'agy'] }, model: str, why: str }),
    }), { feature: 'suggest' })

// ---------- Brain Dump sorter ----------

const SORT_SYSTEM = `You help a developer sort quick notes from their "Brain Dump" inbox into their own lists. For each note pick the list it most likely belongs in, using the list names and the examples already in each list. If there is a "Priority" list, use it only for things that are clearly urgent. If no list fits, answer "Brain Dump". Confidence is 0 to 1. Also tag each note with the one area it belongs to, or "" if none fits.`

export type Suggestion = { id: number; list: string; confidence: number; area: string }

export const sortIdeas = (items: { id: number; text: string }[], lists: { name: string; examples: string[] }[]) =>
  ask<{ suggestions: Suggestion[] }>(
    `Areas: ${AREAS.map(a => a.name).join(', ')}\n\nLists:\n${lists.map(l => `- ${l.name}${l.examples.length ? `: e.g. ${l.examples.map(e => `"${e.slice(0, 80)}"`).join('; ')}` : ''}`).join('\n')}\n\nNotes to sort:\n${items.map(i => `${i.id}: ${i.text.slice(0, 400)}`).join('\n')}`,
    SORT_SYSTEM,
    obj({ suggestions: { type: 'array', items: obj({ id: { type: 'integer' }, list: { type: 'string', enum: [...lists.map(l => l.name), 'Brain Dump'] }, confidence: { type: 'number' }, area: { type: 'string', enum: [...AREAS.map(a => a.name), ''] } }) } }),
    { timeoutMs: 180_000, feature: 'sort' })

// ---------- priorities ----------

const RANK_SYSTEM = `You help a solo founder decide what matters. Given their open notes and ideas (from lists like Brain Dump, Build, Figure Out, Do, Follow Up) and what their coding agents are doing now, give each note a priority: 3 = high (do soon: blocks other work, time-sensitive, or clearly moves the business), 2 = medium (worth doing this week or two), 1 = low (someday), 0 = no priority (reference, done-ish, vague). Be decisive: usually under a fifth of notes are high. Give each a reason of at most 12 words. Then pick up to 5 note ids to do next, best first, and write a two-sentence spoken summary of what to focus on.`

export type Ranked = { ranked: { id: number; priority: number; reason: string }[]; next: number[]; summary: string }

export const rankIdeas = (items: { id: number; list: string; text: string }[], context: string) =>
  ask<Ranked>(`${context}\n\nOpen notes (id · list · text):\n${items.map(i => `${i.id} · ${i.list} · ${i.text.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`, RANK_SYSTEM,
    obj({
      ranked: { type: 'array', items: obj({ id: { type: 'integer' }, priority: { type: 'integer', enum: [0, 1, 2, 3] }, reason: str }) },
      next: { type: 'array', items: { type: 'integer' } }, summary: str,
    }), { timeoutMs: 240_000, feature: 'rank' })

// ---------- interview agent ----------

/** First prompt for a Claude agent that interviews you about an idea, one question at a time, then writes it up. */
export const interviewPrompt = (topic: string) => `Interview me about this idea so we end up with a clear, buildable plan:

<idea>
${topic}
</idea>

Ask one question at a time and wait for my answer before the next. Prefer multiple-choice questions with 2-4 lettered options plus your recommendation, since I'm often answering from my phone; open questions are fine when choices don't fit. Start with purpose and who it's for, then scope, then the details that change what gets built. Push back when something seems not worth building, and say so plainly. Skip anything you can answer by looking at the code yourself.

When you have enough (or I say "wrap up"), propose two or three approaches with your recommendation, then write the agreed plan as a short markdown spec: goal, what's in and out of scope, the design, and open questions. Save it to docs/ideas/ in this repo with a descriptive filename, and also run \`fleet idea -p high "<one-line summary> (spec: <path>)"\` so it lands in my Brain Dump tagged high priority.`

// ---------- Jarvis ----------

const JARVIS_SYSTEM = `You are Jarvis, the assistant built into the developer's Fleet dashboard, which runs their coding agents (Claude Code, Codex, Cursor, Copilot, Antigravity) and holds their idea lists. Think J.A.R.V.I.S.: calm, precise, quietly witty, unflappable, with a light British turn of phrase. Don't call the developer "sir" or by any title; just speak to them.

Your replies are spoken aloud, so keep "say" to one to three short sentences: no markdown, lists, code or file paths read out character by character. Use agent names as written.
Voice conversations keep listening after you answer. Set "end" to true when the developer is wrapping up (they say they're done, thank you and leave it there, or tell you to go away), and make "say" a brief sign-off; otherwise false.

You are also their general project agent. You run inside their project folder and can read files and search the code (Read, Glob, Grep) and the web (WebSearch, WebFetch) to answer questions about the project, its plans and docs, or anything else. Look things up rather than guessing, but keep it quick.

You also run on the developer's Mac, so you can help with their day. To look things up, run these yourself with Bash (nothing else is allowed): \`fleet mac calendar today|tomorrow|week|YYYY-MM-DD\`, \`fleet mac reminders\`, \`fleet mac music now\`, \`fleet mac apps\`, and \`fleet mac screen\` (it saves a screenshot and prints its path; Read that file to see the screen). If one says it's waiting for permission, tell them to allow it on the Mac.

You can read anything Fleet knows, but only fetch what the question needs. With Bash: \`fleet read chat NAME [N]\` (an agent's last N messages, default 40), \`fleet peek NAME\` (its screen right now, where a background job's output shows), and \`fleet read '/api/PATH' [N]\` for the rest: /api/agents (every agent with status, folder, session id, queued messages), /api/agents/NAME/changes (its git changes and commits), /api/paused, /api/history (past conversations), '/api/transcript?tool=claude&id=ID' (one of them), /api/ideas?list=NAME, /api/lists, /api/usage. They only read. When asked how an agent, a job, a scrape or a deploy is going, look (usually chat, then peek) and answer from what you find, including numbers and times; don't say you can't see it. You can't reach other machines yourself, but the agents can: if the file doesn't answer it, offer to ask the agent.

You only read. To change anything, return "actions". Changes to agents (start, reply, key, pause) are shown to the developer as a card to approve before anything happens, so phrase your reply as an offer ("Shall I start a Claude agent to fix the pagination?"), never as done. The idea lists are the developer's own notes: add, check off, reword, move and prioritize them right away when asked, no offer needed. Deleting one is the exception: return the idea_edit action with done = "delete" at once (don't ask first in words); it shows as a card to approve, so say it's waiting for their OK, never that it's deleted. Remember happens right away too.
Actions:
- reply: send text to an agent (agent, text)
- key: press one key in an agent's menu, e.g. "1", "2", "Enter", "Escape", "BTab" for shift+tab (agent, key)
- pause: pause an agent, keeping its conversation (agent; optional text = when to resume, like "18:30" or "+2h")
- start: start a new agent (text = its task; optional tool, model, effort, name)
- idea: add an idea (text; optional list, default "Brain Dump")
- idea_edit: change one idea (edit.id from fleet read '/api/ideas?list=NAME'; fill only what changes, leave the rest empty: text = new wording, notes, list = move it there, done = "done" / "open" / "delete", priority)
- remember: save a lasting note about the developer or project for future conversations (text)
- mac: do something on the Mac (fill "mac"): music_play, music_pause, music_next, music_previous, music_volume (value 0-100), music_search (value), open_app (app), window (app, where = left|right|full|center), and, which the developer approves first: event (title, when "YYYY-MM-DD HH:MM", minutes, calendar), remind (title, when optional, calendar = list name), draft (to, subject, body: an email draft saved in Mail, never sent). Write emails in the developer's voice: short, plain, friendly.
Only propose actions when they'd clearly help or were asked for; for questions just answer. Never kill agents (they can do that from the dashboard). If an agent name is ambiguous or missing, ask instead of guessing.`

export type MacAction = { command: string; title: string; when: string; minutes: string; calendar: string; to: string; subject: string; body: string; app: string; where: string; value: string }
export type IdeaEdit = { id: number; text: string; notes: string; list: string; done: '' | 'done' | 'open' | 'delete'; priority: '' | 'none' | 'low' | 'medium' | 'high' }
export type JarvisAction = { type: 'reply' | 'key' | 'pause' | 'start' | 'idea' | 'idea_edit' | 'remember' | 'mac'; agent: string; text: string; key: string; tool: string; model: string; effort: string; list: string; name: string; mac?: MacAction; edit?: IdeaEdit }
export type JarvisReply = { say: string; end?: boolean; actions: JarvisAction[] }

export const jarvisBrain = (said: string, context: string, memory: string, opts: { cwd: string; resume?: string }) =>
  askFull<JarvisReply>(`${memory ? `What you remember about the developer and project:\n${memory}\n\n` : ''}What's going on right now:\n${context}\n\nThe developer said: "${said}"`, JARVIS_SYSTEM,
    obj({
      say: str,
      end: { type: 'boolean' },
      actions: { type: 'array', items: obj({
        type: { type: 'string', enum: ['reply', 'key', 'pause', 'start', 'idea', 'idea_edit', 'remember', 'mac'] }, agent: str, text: str, key: str, tool: str, model: str, effort: str, list: str, name: str,
        mac: obj({
          command: { type: 'string', enum: ['', 'music_play', 'music_pause', 'music_next', 'music_previous', 'music_volume', 'music_search', 'open_app', 'window', 'event', 'remind', 'draft'] },
          title: str, when: str, minutes: str, calendar: str, to: str, subject: str, body: str, app: str, where: str, value: str,
        }),
        edit: obj({
          id: { type: 'integer' }, text: str, notes: str, list: str,
          done: { type: 'string', enum: ['', 'done', 'open', 'delete'] }, priority: { type: 'string', enum: ['', 'none', 'low', 'medium', 'high'] },
        }),
      }, ['type', 'agent', 'text', 'key', 'tool', 'model', 'effort', 'list', 'name', 'mac']) },
    }), {
      tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash'],
      // Bash only for the read-only Mac and Fleet lookups; anything else is refused without asking
      allow: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash(fleet mac calendar:*)', 'Bash(fleet mac reminders:*)', 'Bash(fleet mac music now)', 'Bash(fleet mac apps)', 'Bash(fleet mac screen)', 'Bash(fleet read:*)', 'Bash(fleet peek:*)'],
      addDirs: [join(FLEET_DIR, 'screens')],
      timeoutMs: 150_000, cwd: opts.cwd, resume: opts.resume, persist: true, feature: 'jarvis',
    })
