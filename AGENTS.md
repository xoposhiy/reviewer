# reviewer

This repo is the source of the agent skill `page-review` and its command `hrev`. The skill shows the HTML pages and
the Markdown files of a project in the browser with a review panel: the reviewer leaves notes or edits a Markdown file,
and a headless Claude Code agent fixes the files. The tool is in `skill/` (Node.js 20, no packages, tests in `skill/test/`),
and `scripts/deploy.mjs` installs the skill for Claude Code and Codex. [README.md](README.md) tells more.

## After each change

1. Release the change on this machine at once: run `npm run deploy`. It runs the tests and installs the skill from `skill/`.
   If a test fails, fix the change and run the release again.
2. Restart the review servers, so that they run the new code: `npm run deploy -- --restart`.
   The command does not restart a server whose agent works on notes, and lists such servers.
   Then ask the user before you restart them with `npm run deploy -- --restart --force`: the restart stops their agents.
3. Then offer to commit and push the change. Commit and push only after the user agrees.
