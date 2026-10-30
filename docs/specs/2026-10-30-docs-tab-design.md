# Docs tab: design

Date: 2026-10-30 · Status: approved design, not built

## What it is

A Docs tab that makes Fleet the one place to read what agents write: plans waiting to be done,
reports and handoffs, specs. You pick the folders that count as notes. The tab shows the
waiting plans (each one can start an agent), what changed lately, a folder list, and a search
across every note. Opening a note shows which other notes link to it. Notes stay as files where
they are, so there's no copy or sync to go stale.

It borrows the useful parts of Obsidian (search, backlinks, browsing) and adds the thing
Obsidian can't do: hand a plan straight to an agent. Editing stays out. Agents write the docs,
and an editor that two writers share invites overwrites. Use Obsidian on the Mac for the rare
hand edit.

## Decisions

| Topic | Decision |
| --- | --- |
| Which folders | A list in Settings (`docs_folders`), plus subfolders to leave out (`docs_skip`). Empty list: the tab says how to add one |
| Which files | `.md` files, hidden folders included (agents keep docs in `.agents/`, `.plans/`), under Fleet's existing guards |
| Plans | Any `.md` directly inside a `plans/pending/` or `.plans/pending/` folder. A convention, documented in the README, not a setting |
| Placement | New `Docs` tab in the bottom bar: Agents · Ideas · 🎤 · Checklists · Docs · More |
| Freshness | Read from disk on every request. No index |
| Editing | No. Read only |
| Graph view | Later, once notes link to each other enough to make a map worth seeing |

## 1. Server: `dashboard/server/docs.ts`

- **`listDocs(folders, skip)`** walks each folder for `*.md`, the way `findFiles` does in
  `files.ts` (both glob patterns, so hidden folders count). It reuses `SKIP`, `SECRET_DIRS`,
  `SECRET_FILE` and `allowed()`. It also skips agent tool config folders (`.claude`, `.cursor`,
  `.codex`, `.gemini`, `.continue`, `.github`), whose skill files would swamp the list, and any
  `docs_skip` entry: a folder name, or a path relative to a docs folder. It returns
  `{ root, rel, title, mtime, plan }` per file. `title` is the first `# ` heading in the
  first 4 KB, else the file name. `plan` is true for the plans convention above.
  `// ponytail:` walk on every request, fine for thousands of notes; an index if it gets slow.
- **`searchDocs(folders, skip, q)`** returns the files that contain every word of `q`
  (case-insensitive), each with its first matching line as a snippet. Files over 2 MB or
  non-text are skipped. At most 50 results, the most recently changed first.
- **`linksTo(folders, skip, root, rel)`** returns the notes that point at a note: their text
  contains its path relative to the root, a relative link that resolves to it, or its bare
  file name if no other note in that folder has the same name. That last rule keeps
  `README.md` from matching everything.

Routes in `index.ts`:

- `GET /api/docs` returns `listDocs(...)`.
- `GET /api/docs/search?q=` returns `searchDocs(...)`.
- `GET /api/docs/links?root=&rel=` returns `linksTo(...)`.
- Reading a note uses the existing `GET /api/files/read` with `cwd=root`.
- Settings `GET`/`PATCH` gain `docs_folders` (each must be an existing folder, same check as
  `cwd`) and `docs_skip`. `Config` gains both fields.

## 2. Page: `dashboard/web/src/docs.tsx`

Four views along the top of the tab. Plans, Recent and Folders come from the single
`/api/docs` response.

- **Plans:** waiting plans, newest first, with their titles. Opening one shows a
  **Start agent** button. It opens the existing `CustomForm` with the folder set to the docs
  root and this first prompt: "Carry out the plan in `<rel>`. Read the project's agent
  instructions first. Delete the plan file when it's finished." You choose the tool, model and
  effort, as with Ideas and Shares.
- **Recent:** every note sorted by last change, with its title, folder and a relative time
  ("2h ago").
- **Folders:** the folders that contain notes, as a tree you tap through. Tapping a note
  opens it.
- **Search:** a box. Results show the title, path and snippet.

Opening a note reuses `FileViewer` from `files.tsx` (markdown rendering, tappable file names).
Below it, **Linked from** lists the notes from `/api/docs/links`, each tappable.

Settings gains a "Docs folders" section: one path per line, and a second box for subfolders
to leave out. For Optimal: `optimal`, leaving out `on-hold` and `optimal-shopping/prev`.

## 3. Errors

- A docs folder that's gone: it's left out of results and Settings shows it in red. One
  missing folder never breaks the tab.
- Unreadable, binary or oversized files: skipped silently in list and search, and the viewer
  shows the existing `FileError` message.
- Secrets: never listed or opened. The existing `allowed()` and `SECRET_FILE` checks apply on
  every path.

## 4. Testing

`dashboard/test/docs.test.ts` builds a temp folder with a plan in `plans/pending/`, one in
`.plans/pending/`, a note in a hidden folder, a skipped folder, a `.env`, two `README.md`
files, and notes that link to each other by path, by relative link and by bare name. It checks:

- `listDocs` finds the right files, marks both plans, reads titles, and leaves out the
  skipped folder and the secret.
- `searchDocs` needs every word and returns the snippet line.
- `linksTo` finds all three kinds of link and doesn't match the duplicate `README.md`.

The UI is checked by hand on the Mac and the phone.

## Not in this version

Editing, graph view, tags and note properties, tables built from notes, templates.
