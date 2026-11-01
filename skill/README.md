# Review

Review HTML pages and Markdown files in the browser. You leave notes on a page or edit a Markdown file; a Claude Code agent fixes them while you read on.

The tool is this folder only: Node.js 20 or newer, no packages. It is the skill `page-review` of Claude Code
(`~/.claude/skills/page-review/`) and Codex (`~/.agents/skills/page-review/`); [SKILL.md](SKILL.md) tells agents when and how to start it.

The source is the repo https://github.com/xoposhiy/reviewer. `npm run deploy` in the repo installs the skill into both agents
and the command `reviewer` (npm links it to the Claude Code copy).

Then, from any folder of a project:

```
reviewer [file ...]      # open pages in the review; no file: the table of contents
reviewer docker.html     # a file is a path, or the end of a path in the project
reviewer list            # the review servers of this computer
reviewer stop [--all]    # stop the server of the project (--all: every server)
reviewer restart         # restart the server of the project
```

The project folder is the git work tree of the current folder (or `--root <dir>`). Each project has its own server
on one of the ports 8765–8784. `reviewer` finds the server of the project, or starts one in the background on the first free port,
and opens each file in the browser. `--no-browser` prints the links only. The output of a server goes to `.review/server.log` of the project.
Without the command: `node "$HOME/.claude/skills/page-review/open.mjs"` with the same arguments.

To run the server by hand, in the foreground: `node server.mjs` with the options below.

A folder URL (`/`, `/materials/07-docker/`) is the table of contents of the folder; the title links to each folder above.
It lists the pages (HTML and Markdown files) of the folder and of its subfolders:

- "Open notes": the pages with open notes, the newest note first, with the start of the note.
- "Changed last": the 8 pages changed last.
- "All pages": the tree of the folder. A folder row shows its count of pages, its open notes and its last change;
  a click opens or closes it, and "open ›" opens its own table of contents. The page remembers the open folders.
  A folder with only one folder in it is one row: `flags/content/`.
- The search box finds pages by their path: each word is a part of the path. The search replaces the three lists.
- Keys: `/` goes to the search, `↑` `↓` choose a row, `Enter` opens it, `←` `→` close and open a folder, `Esc` clears the search.
- The pages that git ignores are hidden; the "git-ignored" box shows them. A page with open notes is in "Open notes" anyway.
- The page that you came from (for example by "☰ Contents" in the panel) has the mark "you were here".

The agent status and its Stop or Start button are at the top. At the bottom: the output of the agent,
and every review server of this computer, with Stop and Restart.
Not in the lists: dot folders (for example `.git`), `node_modules` and the folder of this tool.
An `index.html` opens by its name only (`/sub/index.html`): `/sub/` is the table of contents.

Options:

| Option | Default | What it does |
|---|---|---|
| `--root <dir>` | the current folder | The folder with the pages. The agent works in this folder. |
| `--port <n>` | `8765` | The port. `0` takes any free port. |
| `--data <dir>` | `<root>/.review` | The folder for the notes. The server puts a `.gitignore` with `*` in it, so git ignores the folder. |
| `--agent <command>` | `claude` | The agent command. Tests give a fake agent here. |

The server listens only on 127.0.0.1, and it refuses changes from pages of other sites.

## The panel

The server adds the panel to each HTML page that it serves.

- The ✎ button: open the panel. `Esc`: close it. "☰ Contents" in the panel: the table of contents of the folder of the page. A click on the page outside the panel closes it too; the draft stays.
- `Alt+click` on the page: attach the element under the cursor to the note.
- Send the note and close the panel: "Ω Send" or `Ctrl+Enter` gives the note to an Opus agent; "Σ Send" or `Ctrl+Shift+Enter` to a Sonnet agent.
- Under an attached element, "Can't pick a smaller part" and "Picks the wrong part" send a note at once, to Opus:
  a task to fix the page markup, so that Alt+click picks the right part. The draft text goes after the task.
- Each note keeps its place on the page. "open here" opens that place again.
- "delete" removes a note. A note in work has no "delete": stop the agent first.
- When the page file changes, a banner offers "Reload here".
- The draft stays when the page reloads.

The keys, the clicks and the wheel turns in the panel do not go to the page.

[PAGES.md](PAGES.md) says how to make a page that the panel understands well: how the page tells its place, how it opens a place,
and what Alt+click picks. Give it to the authors of the pages, people and agents.

## Markdown files

A Markdown file (`.md`, `.markdown`) opens in the Markdown view: the browser renders it with markdown-it
(from cdn.jsdelivr.net, so the view needs the internet; without it, the view shows the file as text).
The panel stays open at the right side. `?raw` after the file name gives the file itself.

- The path of the file at the top: the project and each folder link to their tables of contents.
- Each block has the ✎ button in the left margin: a paragraph, a heading, a table, a code block, a quote, an item of a top-level list.
- Further left, a heading has § (its whole section: up to the next heading of the same or a higher level),
  and a top-level list has ≡ (the whole list: delete, add and move its items).
- ✎ opens the source of the block; § and ≡ open the source of the section or of the list. Write the new text in any language and as roughly as you like. You can also write a note to the agent.
- "Ω Save" or `Ctrl+Enter`, "Σ Save" or `Ctrl+Shift+Enter`: the server writes the new text to the file at once,
  and a note gives the edit to the agent. The agent finishes the edit (the language of the project, the grammar, the style)
  and changes the rest of the file and the other files of the project that the edit makes wrong.
- With no change in the text, "Save" sends only the note about the block.
- `Esc` or "Cancel": close the block, the file stays as it was.
- If the file changed and has no such block now, the server refuses the edit. Copy your text, cancel and edit again.
- When the file changes, the view renders it again; during an edit, after the edit.

The panel shows each edit as the text before and after.

## The agent

The server runs a headless Claude Code (`claude -p --permission-mode auto`) in the folder with the pages. [agent.md](agent.md) is its task.

- The agent starts on a new note or on the Start button, never on the server start. While open notes exist, it takes task after task.
- One task: up to 3 related open notes of one page. The agent marks them `wip`.
- A task runs with the model of the oldest open note.
- Each model has its own session. The next task of a model resumes the session until the context reaches 100k tokens; then a new session starts.
  Each session has a short name (`a1`, `a2`, ...). The panel shows it on each note.
- The Stop button kills the agent and turns the start on new notes off. Start turns it on. `open.mjs --stop` and `Ctrl+C` on the server kill the agent too.
- The notes that a stopped agent left in `wip` go back to the queue: when it exits, when it prints nothing for 15 min
  (the server kills it), and on the server start. After 2 such stops a note becomes `stuck`, and the agents skip it.
- A task that closes no note stops the queue with an error, so that a broken agent does not restart forever.
- When a task ends, its cost and its time are split equally between its notes. The panel shows them on each note,
  and the totals for the page at the top.

The page `/` shows the agent status and its output. The server output (`.review/server.log` or the server window) has it too.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The skill: when an agent opens the review, and how it makes pages for it. |
| `open.mjs` | The command `reviewer` (`package.json`): opens pages, lists, stops and restarts the servers. |
| `servers.mjs` | The review servers of this computer: find, start, stop, restart. |
| `server.mjs` | The HTTP server: the pages with the panel, the table of contents and the API. |
| `store.mjs` | The notes and the replies in the data folder. |
| `agent.mjs` | Runs the agent: the queue, the sessions, the cost. |
| `agent.md` | The task of the agent. |
| `panel.js` | The panel in the page. |
| `markdown.html`, `markdown.js` | The Markdown view. |
| `index.html` | The table of contents of a folder, with the agent and the servers. |
| `PAGES.md` | The convention for the pages. |
| `test/` | The tests with a fake agent: `npm test` in the repo. Only in the repo: the install leaves it out. |
| `INSTALLED.json` | Only in an installed copy: the local clone of the repo that the install came from, the commit and the time. |

The data folder:

| File | Who writes it | What it is |
|---|---|---|
| `notes.jsonl` | the server | The notes, one JSON object per line. |
| `replies.json` | the agent and the server | `{id: {status, reply, session, started, tries, cost, ms, sessions}}`. Status: `open`, `wip`, `fixed`, `no`, `stuck`. A note with no entry is open. |
| `last-id` | the server | The number of the last note, so that the id of a deleted note is not used again. |
| `agent.json` | the server | The session of each model and the short names of the sessions. |
| `agent.log` | the server | The full output of the agents. |
| `server.log` | `open.mjs` | The output of the server that `open.mjs` started. |
| `.gitignore` | the server | `*`: git ignores the data folder. |
