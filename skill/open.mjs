#!/usr/bin/env node
// The command `reviewer` (package.json). `reviewer [file ...]` opens files of a project in the review: it finds the review
// server of the project, or starts one in the background, then opens each file in the browser. `list`, `stop` and `restart`
// control the servers. The project folder: --root, else the git work tree of the current folder, else the current folder.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { samePath, servers, start, stop } from './servers.mjs';

const USAGE = `Usage:
  reviewer [file ...]      open pages of the project in the review; no file: the table of contents
                           file: a path, or the end of a path in the project (docker.html, 07-docker/notes.md)
  reviewer list            the review servers of this machine
  reviewer stop [--all]    stop the review server of the project (--all: every review server)
  reviewer restart         restart the review server of the project
Options:
  --root <dir>   the project folder (default: the git work tree of the current folder, else the current folder)
  --no-browser   print the links, open no browser`;
const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string' }, 'no-browser': { type: 'boolean' }, all: { type: 'boolean' }, port: { type: 'string' },
    help: { type: 'boolean', short: 'h' } },
});
if (opt.help) { console.log(USAGE); process.exit(0); }
const COMMANDS = new Set(['list', 'stop', 'restart']);
const command = COMMANDS.has(positionals[0]) ? positionals.shift() : 'open';
const files = positionals;

function projectRoot() {
  if (opt.root) return resolve(opt.root);
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  return git.status === 0 && git.stdout.trim() ? resolve(git.stdout.trim()) : resolve('.');
}
const ROOT = projectRoot();
const slash = p => p.split(sep).join('/');
const all = await servers();
const mine = all.find(s => samePath(s.root, ROOT));

// The path of a file from the root. A name that is not a path from the current folder is the end of a path:
// the file is the one file of the project whose path ends with it. Dot folders and node_modules are left out.
function pathOf(f) {
  const exact = relative(ROOT, resolve(f));
  if (existsSync(resolve(f))) return isAbsolute(exact) || exact.startsWith('..') ? { error: `not in the project folder ${ROOT}` } : { path: slash(exact) };
  const tail = '/' + f.replaceAll('\\', '/').replace(/^\.?\//, '');
  const found = [];
  (function walk(dir) {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) { if (!d.name.startsWith('.') && d.name !== 'node_modules') walk(p); }
      else if (('/' + slash(relative(ROOT, p))).endsWith(tail)) found.push(slash(relative(ROOT, p)));
    }
  })(ROOT);
  if (found.length === 1) return { path: found[0] };
  return { error: found.length ? `${found.length} files fit, give more of the path:\n  ${found.join('\n  ')}` : 'no such file in the project' };
}

const clock = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const line = s => `${samePath(s.root, ROOT) ? '*' : ' '} http://localhost:${s.port}/  ${s.root}\n    ` +
  (s.pid ? `agent: ${s.agent.text} · ${s.open} open note(s) · since ${clock(s.since)} · pid ${s.pid}` : 'an older version of the tool: restart it');
const noServer = () => console.log(`No review server runs for ${ROOT}.`);

// no process.exit() after a fetch: on Windows, Node can crash on the exit while the fetch closes its handles
const run = {
  list() {
    if (!all.length) return console.log('No review servers run.');
    console.log(all.map(line).join('\n') + (mine ? '\n* the project of the current folder' : ''));
  },

  async stop() {
    const list = opt.all ? all : mine ? [mine] : [];
    if (!list.length) return opt.all ? console.log('No review servers run.') : noServer();
    for (const s of list) console.log(`${await stop(s.port) ? 'Stopped' : 'Did not stop'}: http://localhost:${s.port}/  ${s.root}`);
  },

  // --port: the port of the old server, from the restart button of the page of contents
  async restart() {
    const port = opt.port ? +opt.port : mine?.port;
    if (!port) return noServer();
    if (!(await stop(port))) { console.error(`The server on the port ${port} did not stop.`); return void (process.exitCode = 1); }
    const now = await start(ROOT, port);
    if (!now) { console.error(`The review server did not start. See ${join(ROOT, '.review', 'server.log')}.`); return void (process.exitCode = 1); }
    console.log(`Restarted: http://localhost:${now}/  ${ROOT}`);
  },

  async open() {
    const paths = [];
    for (const f of files) {
      const r = pathOf(f);
      if (r.error) { console.error(`${f}: ${r.error}`); process.exitCode = 1; } else paths.push(r.path);
    }
    if (files.length && !paths.length) return;
    const port = mine?.port ?? await start(ROOT);
    if (!port) {
      console.error(`The review server did not start. See ${join(ROOT, '.review', 'server.log')}.`);
      return void (process.exitCode = 1);
    }
    const base = `http://localhost:${port}/`;
    console.log(`Review server for ${ROOT}: ${base} (${mine ? 'already running' : 'started'})`);
    const links = files.length ? paths.map(p => base + p.split('/').map(encodeURIComponent).join('/')) : [base];
    for (const url of links) {
      console.log(url);
      if (opt['no-browser']) continue;
      const [cmd, ...args] = process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url]
        : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
      spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    }
  },
};
await run[command]();
