# reviewer

The source of the agent skill `page-review` and its command `reviewer`.

The skill shows the HTML pages and the Markdown files of a project in the browser with a review panel.
You leave notes on a page or edit a Markdown file, and a headless Claude Code agent fixes the files.
[skill/README.md](skill/README.md) describes the tool, and [skill/SKILL.md](skill/SKILL.md) tells agents when and how to use it.

## Requirements

- Node.js 20 or newer. The tool uses no packages.
- Claude Code (`claude` in `PATH`): the review server starts it to fix the notes.

## Install

```
npm run deploy
```

The command:

1. Runs the tests. If a test fails, it installs nothing.
2. Replaces the installed copies of the skill with the files of `skill/` (without `skill/test/`):
   - Claude Code: `~/.claude/skills/page-review/` (or `$CLAUDE_CONFIG_DIR/skills/page-review/`);
   - Codex: `~/.agents/skills/page-review/`.
3. Writes `INSTALLED.json` into each copy: this folder, the commit, and whether `skill/` had uncommitted changes.
4. Installs the command `reviewer` with `npm install -g`. npm links the command to the Claude Code copy.
5. Lists the running review servers. They run the old code until they restart.

Options (after `--`, for example `npm run deploy -- --restart`):

| Option | What it does |
|---|---|
| `--only <claude\|codex>` | Install into one agent only. |
| `--skip-tests` | Install without the tests. |
| `--restart` | Restart the running review servers, so that they run the new code. |

## Develop

Change the files in `skill/`, not the installed copies: the next install replaces them.

```
npm test          # the tests with a fake agent
npm run deploy    # install the changed skill
```

## Files

| Path | What it is |
|---|---|
| `skill/` | The skill folder. The install copies it into each agent. |
| `skill/test/` | The tests. The install leaves this folder out. |
| `scripts/deploy.mjs` | The install script (`npm run deploy`). |
