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

At the top: one short line about the agent of the project, for example "Agent works · 2 notes wait" or "3 notes wait · auto in 1:40";
hover over it for the full status. While the agent works, Stop is next to it. Fix in the panel starts the agent.
At the bottom: every review server of this computer, with Stop and Restart.
Not in the lists: dot folders (for example `.git`), `node_modules` and the folder of this tool.
An `index.html` opens by its name only (`/sub/index.html`): `/sub/` is the table of contents.

Options:

| Option | Default | What it does |
|---|---|---|
| `--root <dir>` | the current folder | The folder with the pages. The agent works in this folder. |
| `--port <n>` | `8765` | The port. `0` takes any free port. |
| `--data <dir>` | `<root>/.review` | The folder for the notes. The server puts a `.gitignore` with `*` in it, so git ignores the folder. |
| `--agent <command>` | `claude` | The agent command. Tests give a fake agent here. |
| `--delay <seconds>` | `120` | The agent starts by itself this long after the last new note. Tests give `0` or a few seconds here. |

The server listens only on 127.0.0.1, and it refuses changes from pages of other sites.

## The panel

The server adds the panel to each HTML page that it serves. The panel follows the light or dark color scheme of the system.

- The "✎ Note" button at the bottom right: open the panel. The panel opens at the right side of the window, full height, over the page:
  the page keeps its layout. `Esc` or ✕: close it. A click on the page outside the panel that selects nothing closes it too; the draft stays.
  "☰ Contents" in the panel: the table of contents of the folder of the page.
- Select text on the page with the mouse: the panel opens, and the note quotes the text. The panel shows the quote under the draft and keeps it when you click in the panel.
  A new selection replaces the quote. A click on the page that selects nothing, or ✕, removes it.
- `Alt+click` on the page: attach the element under the cursor to the note.
- A note points at one thing: a quote or an element. Both stay only when the quote is a part of the element:
  Alt+click a big element, then select the words in it. Alt+click on an element that does not hold the quote removes the quote,
  and a selection out of the attached element removes the element.
- Send the note and close the panel: "Ω Send" or `Ctrl+Enter` gives the note to an Opus agent; "Σ Send" or `Ctrl+Shift+Enter` to a Sonnet agent.
- Next to ✕ of an attached element, "⋯" shows two buttons: "Can't pick a smaller part" and "Picks the wrong part".
  Each sends a note at once, to Opus: a task to fix the page markup, so that Alt+click picks the right part. The draft text goes after the task.
- While open notes wait and no agent runs, the agent line has the button "Fix 3 · auto in 1:40": the count of the open notes
  of the project and the time to the start by itself. "Fix" starts the agent at once. With the panel closed, the same button
  "▶ Fix 3 · auto in 1:40" is next to "✎ Note", so you see that the work did not start yet.
- Each note keeps its place on the page. "open here" opens that place again and highlights for a moment what the note is about:
  the quoted text (in browsers with the CSS Custom Highlight API), else the attached element. If the page has neither of them now,
  it stays at the place.
- Under a closed note (fixed or not fixed):
  - "Reply" puts the draft into reply mode: "↪ Reply to n5 ✕" is above the draft, and ✕ leaves the mode.
    The next note is a reply to n5 (the field `re`). The list shows "↪ n5" on the reply; a click shows n5.
  - "Looks good" accepts the result. The note goes to "Archive (N)" at the bottom of the list; "Back to the list" takes it back.
    The cost line of the page counts the archive too.
- "delete" removes a note at once, with no question. A note in work has no "delete": stop the agent first.
- Hover over a short label (Ω, Σ, o2, a status, the agent line, the cost line, Fix) for its explanation.
- When the page file changes, a banner offers "Reload here".
- The draft stays when the page reloads.

The keys, the clicks and the wheel turns in the panel do not go to the page.

[PAGES.md](PAGES.md) says how to make a page that the panel understands well: how the page tells its place, how it opens a place,
and what Alt+click picks. Give it to the authors of the pages, people and agents.

## Markdown files

A Markdown file (`.md`, `.markdown`) opens in the Markdown view: the browser renders it with markdown-it
(from cdn.jsdelivr.net, so the view needs the internet; without it, the view shows the file as text).
The panel stays open at the right side, with the same layout as on an HTML page, and the text of the file moves left to make room for it.
The panel has no ✕ there. `?raw` after the file name gives the file itself.

LaTeX math is rendered with KaTeX (also from cdn.jsdelivr.net):

- `\[` or `$$` at the start of a line opens a display formula, and the line that ends with `\]` or `$$` closes it.
  A one-line formula `\[ … \]` or `$$ … $$` is a display formula too. A blank line inside the formula makes it text.
- `\( … \)` is a formula inside a line of text. A single `$` is text: `$5 and $10` stays as it is.
- `\[ … \]` and `$$ … $$` in the middle of a line stay text, because `\[1\]` is often a pair of escaped brackets.
- A formula with an error shows its source in red. Without KaTeX, the view shows the source of each formula.

- The path of the file at the top: the project and each folder link to their tables of contents.
- Each block has the ✎ button in the left margin: a paragraph, a heading, a table, a code block, a quote, an item of a top-level list.
- Further left, a heading has § (its whole section: up to the next heading of the same or a higher level),
  and a top-level list has ≡ (the whole list: delete, add and move its items).
- ✎ opens the source of the block; § and ≡ open the source of the section or of the list. Write the new text in any language and as roughly as you like. You can also write a note to the agent.
- "Ω Save" or `Ctrl+Enter`, "Σ Save" or `Ctrl+Shift+Enter`: the server writes the new text to the file at once,
  and a note gives the edit to the agent. The agent finishes the edit (the language of the project, the grammar, the style)
  and changes the rest of the file and the other files of the project that the edit makes wrong.
- With no change in the text, "Save" sends only the note about the block.
- "Save only": the server writes the new text to the file, and makes no note. The agent does not start.
- `Esc`, "Cancel", a click outside the editor or the ✎ of another block: close the editor, the file stays as it was.
  A changed text (or note) stays as the draft of the block: the next ✎ on the block opens it again, and the ✎ of the block
  stays visible with a mark. The drafts live in this page only: a reload drops them. With a change, Cancel stands out,
  and "Reset" takes the editor back to the text of the file and drops the draft.
- If the block changed while you edited it (often the agent changed it), the server does not write your text.
  It gives the edit to the agent as a note, also after "Save only": the agent merges your edit into the current text.
  The note goes to the session that changes the page now, else to the session that changed it last.
  The view shows the current file, and the panel marks the note "the block changed: the agent merges it".
- When the file changes, the view renders it again; during an edit, after the edit.

The panel shows each edit as the text before and after. "open here" on an edit, or on a note about a block, highlights the block for a moment.
If the file changed since then, the view looks for the block by its line, then by its text.

## The agent

The server runs a headless Claude Code (`claude -p --permission-mode auto`) in the folder with the pages. [agent.md](agent.md) is its task.

- A new note does not start the agent at once. The agent starts on the Fix (or Start) button, or by itself 2 minutes
  (`--delay`) after the last new note: each new note starts the count again. While open notes exist, it takes task after task.
  While an agent runs, new notes wait in the queue for the next task.
- The agent does not start on the server start. Only a count that the last server did not finish goes on: the time left, or the full delay.
- Each model has its own session. The next task of a model resumes the session until the context reaches 100k tokens; then a new session starts.
  Each session has a short name: the first letter of its model and a number (`o1`, `o2` for Opus, `s1`, `s2` for Sonnet). The panel shows it on each note.
- The server chooses the notes of each task ([queue.mjs](queue.mjs)), marks them `wip` and names them in the task:
  - A task starts with the oldest open note of its model, and takes up to 2 more open notes at the same place
    (the same page and the same hash of the place), the oldest first. 3 notes at most.
  - Opus also takes the Sonnet notes at the place of its note: one task instead of two. Sonnet never takes an Opus note.
  - A switch of the model starts with a cold prompt cache. So the model of the last task keeps the turn while it has a note to start with,
    if that task ended less than 5 minutes ago and kept its session. But the other model gets the turn when its oldest note is older
    by more than 10 minutes. With no such model, the oldest note chooses the model.
  - A reply goes to the session that closed its note, with the model of that session, while that session is the current session
    of its model. After a new session of that model, the reply goes as a usual note. A reply sent with a stronger model
    (Ω to a note that Sonnet closed) goes to the stronger model.
- The Stop button kills the agent and turns the start by itself off. Fix or Start starts the agent and turns it on again.
  `open.mjs --stop` and `Ctrl+C` on the server kill the agent too.
- The notes that a stopped agent left in `wip` go back to the queue: when it exits, when it prints nothing for 15 min
  (the server kills it), and on the server start. After 2 such stops a note becomes `stuck`, and the agents skip it.
- A task that closes no note stops the queue with an error, so that a broken agent does not restart forever.
- When a task ends, its cost and its time are split equally between its notes. The panel shows them on each note,
  and the totals for the page at the top.

The page `/` shows the agent status and its output. The server output (`.review/server.log` or the server window) has it too.

The session page (`/__review/session?id=<session>`) shows what one agent session does and did. The panel opens it in a new tab:
a click on the status of a working agent, on an "in work" status, or on the agent name of a note. The page shows:
- what the agent does now (a running tool, or the model at work on its next step), and how long it does it;
- each task of the session with its notes, and each step: the text and the thinking of the model, the tool calls with their input
  and result. Each step has its time: the model time before the step and the tool time. Steps of 30 s and more are yellow, of 2 min and more red;
- the totals: the context and its limit, the cost of the ended tasks, the time of the model and of the tools, the tokens, the tools.

## Files

| File | What it is |
|---|---|
| `SKILL.md` | The skill: when an agent opens the review, and how it makes pages for it. |
| `open.mjs` | The command `reviewer` (`package.json`): opens pages, lists, stops and restarts the servers. |
| `servers.mjs` | The review servers of this computer: find, start, stop, restart. |
| `server.mjs` | The HTTP server: the pages with the panel, the table of contents and the API. |
| `store.mjs` | The notes and the replies in the data folder. |
| `agent.mjs` | Runs the agent: the start, the sessions, the cost. |
| `queue.mjs` | Chooses the notes and the model of the next task. |
| `session.mjs` | The log of a session: the records of the agent events, and the view of the session page. |
| `session.html` | The session page. |
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
| `notes.jsonl` | the server | The notes, one JSON object per line. A reply has `re`: the id of its note. `to`: the session that the server gave the note to (an edit of a block that changed meanwhile). |
| `replies.json` | the agent and the server | `{id: {status, reply, session, started, tries, cost, ms, sessions, accepted}}`. Status: `open`, `wip`, `fixed`, `no`, `stuck`. A note with no entry is open. `accepted`: the time of "Looks good". |
| `last-id` | the server | The number of the last note, so that the id of a deleted note is not used again. |
| `agent.json` | the server | The session of each model, the short names of the sessions and the time of the start by itself (`due`). |
| `agent.log` | the server | The full output of the agents. |
| `sessions/<session>.jsonl` | the server | The log of each session: its tasks and their steps, with times and token counts ([session.mjs](session.mjs)). |
| `server.log` | `open.mjs` | The output of the server that `open.mjs` started. |
| `.gitignore` | the server | `*`: git ignores the data folder. |
