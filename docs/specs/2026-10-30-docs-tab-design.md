# Docs tab: design

Date: 2026-10-30 · Status: built

## What it is

A Docs tab that makes Fleet the one place to read what agents write: plans waiting to be done,
reports and handoffs, specs. You pick the folders that count as notes. The tab shows the
waiting plans (each one can start an agent), what changed lately, a folder list, and a search
across every note. Opening a note shows which other notes link to it. Notes stay as files where
they are, so there's no copy or sync to go stale.

It covers what Obsidian was used for (search, backlinks, browsing, a map of linked notes, hand
edits) and adds the thing Obsidian can't do: hand a plan straight to an agent. Editing is a plain
text box; saving refuses if an agent changed the file since it was opened.

## Decisions

| Topic | Decision |
| --- | --- |
| Which folders | A list in Settings (`docs_folders`), plus subfolders to leave out (`docs_skip`). Empty list: the tab says how to add one |
| Which files | `.md` files, hidden folders included (agents keep docs in `.agents/`, `.plans/`), under Fleet's existing guards |
| Plans | Any `.md` directly inside a `plans/pending/` or `.plans/pending/` folder. A convention, documented in the README, not a setting |
| Placement | New `Docs` tab in the bottom bar: Agents · Ideas · 🎤 · Checklists · Docs · More; Docs in the Mac sidebar |
| Freshness | Read from disk on every request. No index |
| Editing | Plain text box. Save sends the `mtime` the note was read at; a newer file on disk is refused (409) |
| Map | All linked notes, laid out by a small spring simulation in the page. No graph library |

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
- **Links**: a note points at another when its text mentions a `.md` path that resolves to it,
  relative to the note or to the docs folder, or a file name only one note in that folder has.
  Several notes sharing a name (`README.md`) match only on the longest path that ends with one.
  `note(path)` returns the note's text, `mtime`, and the notes linking to it. `graph()` returns
  every linked note and the links between them.
- **`saveDoc(folders, path, text, mtime)`** writes a hand edit. Only `.md` files inside a docs
  folder, under the same secret guards, and only if the file's `mtime` still matches.

Routes in `index.ts`:

- `GET /api/docs` returns `listDocs(...)`.
- `GET /api/docs/search?q=` returns `searchDocs(...)`.
- `GET /api/docs/note?path=` returns `note(...)`.
- `GET /api/docs/graph` returns `graph(...)`.
- `PUT /api/docs/file` with `{ path, text, mtime }` saves an edit.
- Settings `GET`/`PATCH` gain `docs_folders` (each must be an existing folder, same check as
  `cwd`) and `docs_skip`. `Config` gains both fields.

## 2. Page: `dashboard/web/src/docs.tsx`

Five views along the top of the tab: Plans, Recent, Folders, Search, Map. Plans, Recent and
Folders come from the single `/api/docs` response.

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

A note opens on the right (full screen on the phone), formatted with the chat's Markdown. A
file name in it opens that note in place, or Fleet's file viewer for anything that isn't a
note. Below it, **Linked from** lists the notes linking here. **Edit** swaps in a text box with
Save and Cancel.

- **Map:** dots for notes (bigger for more links), lines for links, colored by top folder, the
  eight busiest labelled, hovering a dot highlights its links. Tap a dot to open the note.
  Zoom buttons, scrolls when zoomed.

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
- `note` finds all three kinds of link and doesn't match the duplicate `README.md`; `graph`
  counts the same links.
- `saveDoc` saves, refuses when the file changed since it was read, and refuses outside the
  docs folders.

The UI is checked by hand on the Mac and the phone.

## Not in this version

Tags and note properties, tables built from notes, templates, links across docs folders.
