---
name: page-review
description: Review of HTML pages and Markdown files in the browser, with notes that a headless Claude agent fixes. Use when you hand the user an HTML page or a Markdown file to read or check (a report, a doc, a spec, a plan, slides, a study page), when the user asks to open a page for review, or when you make an HTML page that the user will review.
---

# Page review

A local server shows the pages of a project in the browser with a review panel. The user leaves notes on a page (Alt+click attaches an element), or edits a block of a Markdown file in place. The server gives each note to its own headless Claude agent, and the agent fixes the files.

The tool is this folder. [README.md](README.md) describes the panel, the Markdown view and the agent.

## 1. Make an HTML page reviewable

Every HTML page for people follows [PAGES.md](PAGES.md). The short form:

- A page that scrolls: each section has an `id`.
- A page that shows one place at a time (slides, steps, tabs): it defines `window.reviewState = () => ({ where, hash })` and opens the place from `location.hash` on load and on `hashchange`.
- Each text that a person can comment on is in its own element; layers over the content have `pointer-events: none`.
- Parts that repeat have `data-review="<name>"`; an SVG shape and its label are in one `<g>`.
- Alt+click, `<review-panel>`, `data-review-picked` and `window.reviewState` keep the meaning that PAGES.md gives them.

A Markdown file needs nothing.

## 2. Open the review

Open the review when you hand the user a page or a Markdown file to read: you ask the user to read, check or comment on it, or the document is what the user asked you to make.
Keep it for documents for people: app code, templates, test fixtures and files that you only touch on the way stay out.

Run this from the project folder, with the files that the user reads:

```
reviewer <file> [file ...]
```

- The command finds the review server of the project (the git work tree, or `--root <dir>`) or starts one in the background, and opens each file in the browser.
- Give the user the links that it prints.
- Open a file once in a session. When you change it again, the open page shows the change itself (a "Reload here" banner, or a new render of a Markdown file).
- The server listens on 127.0.0.1 and later starts `claude`. If a sandbox blocks the command, ask for permission to run it outside the sandbox, or give the user the command.
- No `reviewer` command: run `node <this folder>/open.mjs` with the same arguments (give the absolute path of `open.mjs`), and tell the user that `npm run deploy` in the source repo of the skill installs the command.
- `reviewer list`, `reviewer stop [--all]` and `reviewer restart` control the servers, when the user asks; `reviewer --help` lists the options.

## 3. Notes

The agent of the review server fixes the notes, so the notes are its work. Handle notes yourself only when the user asks: then read `.review/notes.jsonl` and `.review/replies.json` and work as [agent.md](agent.md) says.

## Change the tool

This folder is an installed copy of the skill: an install replaces it, so do not change the files here.
The source is the repo https://github.com/xoposhiy/reviewer; `INSTALLED.json` in this folder names the local clone (`source`) and the commit.
Change the files in `skill/` of the clone, run `npm test`, and keep `README.md` and `PAGES.md` true.
Then `npm run deploy` in the clone installs the skill into Claude Code and Codex.
