// The dashboard's smart features, run through the Claude Code CLI on your own subscription (no API key):
// prompt improver, model recommender, Brain Dump sorter, interview prompt and Jarvis's brain.
// Every call is a one-shot `claude -p` in ~/.fleet/ai with structured output and no saved session.
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { FLEET_DIR } from './store.ts'

const AI_DIR = join(FLEET_DIR, 'ai')
mkdirSync(AI_DIR, { recursive: true })
export const AI_MODEL = process.env.FLEET_AI_MODEL ?? 'sonnet'

type Schema = Record<string, unknown>

export function ask<T>(task: string, system: string, schema: Schema, opts: { tools?: string[]; timeoutMs?: number; cwd?: string } = {}): Promise<T> {
  const args = ['-p', '--model', AI_MODEL, '--output-format', 'json', '--no-session-persistence',
    '--system-prompt', system, '--json-schema', JSON.stringify(schema),
    ...(opts.tools?.length ? ['--allowedTools', ...opts.tools] : []), '--', task]
  return new Promise((resolve, reject) => {
    execFile('claude', args, { cwd: opts.cwd ?? AI_DIR, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(err.killed ? 'Claude took too long' : `claude failed: ${err.message.split('\n')[0]}`))
      try {
        const out = JSON.parse(stdout)
        if (out.is_error || !out.structured_output) return reject(new Error(out.result || 'Claude returned no answer'))
        resolve(out.structured_output as T)
      } catch {
        reject(new Error('could not read Claude’s answer'))
      }
    })
  })
}

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
    project ? { cwd: project, tools: ['Read', 'Glob', 'Grep'], timeoutMs: 150_000 } : {})

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
    }))

// ---------- Brain Dump sorter ----------

const SORT_SYSTEM = `You help a developer sort quick notes from their "Brain Dump" inbox into their own lists. For each note pick the list it most likely belongs in, using the list names and the examples already in each list. Use "Priority" only for things that are clearly urgent. If no list fits, answer "Brain Dump". Confidence is 0 to 1.`

export type Suggestion = { id: number; list: string; confidence: number }

export const sortIdeas = (items: { id: number; text: string }[], lists: { name: string; examples: string[] }[]) =>
  ask<{ suggestions: Suggestion[] }>(
    `Lists:\n${lists.map(l => `- ${l.name}${l.examples.length ? `: e.g. ${l.examples.map(e => `"${e.slice(0, 80)}"`).join('; ')}` : ''}`).join('\n')}\n\nNotes to sort:\n${items.map(i => `${i.id}: ${i.text.slice(0, 400)}`).join('\n')}`,
    SORT_SYSTEM,
    obj({ suggestions: { type: 'array', items: obj({ id: { type: 'integer' }, list: { type: 'string', enum: [...lists.map(l => l.name), 'Brain Dump'] }, confidence: { type: 'number' } }) } }),
    { timeoutMs: 180_000 })

// ---------- interview agent ----------

/** First prompt for a Claude agent that interviews you about an idea, one question at a time, then writes it up. */
export const interviewPrompt = (topic: string) => `Interview me about this idea so we end up with a clear, buildable plan:

<idea>
${topic}
</idea>

Ask one question at a time and wait for my answer before the next. Prefer multiple-choice questions with 2-4 lettered options plus your recommendation, since I'm often answering from my phone; open questions are fine when choices don't fit. Start with purpose and who it's for, then scope, then the details that change what gets built. Push back when something seems not worth building, and say so plainly. Skip anything you can answer by looking at the code yourself.

When you have enough (or I say "wrap up"), propose two or three approaches with your recommendation, then write the agreed plan as a short markdown spec: goal, what's in and out of scope, the design, and open questions. Save it to docs/ideas/ in this repo with a descriptive filename, and also run \`fleet idea -l Priority "<one-line summary> (spec: <path>)"\` so it shows up in my Ideas.`

// ---------- Jarvis ----------

const JARVIS_SYSTEM = `You are Jarvis, the voice assistant inside the developer's Fleet dashboard, which runs their coding agents. Answer out loud: one to three short spoken sentences, no markdown, no lists, no code. Use agent names as written.

You can act through "actions" (they run after you answer):
- reply: send text to an agent that is waiting (agent, text)
- key: press one key in an agent's menu, e.g. "1", "2", "Enter", "Escape" (agent, key)
- pause: pause an agent, keeping its conversation (agent)
- start: start a new agent (tool, prompt; optional name, model, effort)
- idea: add an idea to a list (text; optional list, default "Brain Dump")
Only act when the developer asked for it; for questions just answer. Never kill agents (say they can do that from the dashboard). If the request names an agent that doesn't exist or is ambiguous, ask which one instead of guessing. For general questions (weather, scores, news) use web search and answer briefly.`

export type JarvisAction = { type: 'reply' | 'key' | 'pause' | 'start' | 'idea'; agent: string; text: string; key: string; tool: string; model: string; effort: string; list: string; name: string }

export const jarvis = (said: string, context: string) =>
  ask<{ say: string; actions: JarvisAction[] }>(`What's going on right now:\n${context}\n\nThe developer said: "${said}"`, JARVIS_SYSTEM,
    obj({
      say: str,
      actions: { type: 'array', items: obj({
        type: { type: 'string', enum: ['reply', 'key', 'pause', 'start', 'idea'] }, agent: str, text: str, key: str, tool: str, model: str, effort: str, list: str, name: str,
      }) },
    }), { tools: ['WebSearch', 'WebFetch'], timeoutMs: 90_000 })
