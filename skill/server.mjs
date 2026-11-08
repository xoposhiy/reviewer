// Review server: serves the HTML pages of a folder and adds the review panel (panel.js) to each page.
// A Markdown file opens in the Markdown view (markdown.html, markdown.js): an edit of a block changes the file and becomes a note.
// The notes go to the data folder (store.mjs). The review agent (agent.mjs) fixes them.
// The session page (session.html) shows what an agent session does: the panel links to it.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createStore, CLOSED } from './store.mjs';
import { createAgent, DELAY_MS, modelOf, MODELS } from './agent.mjs';
import { parseLog, viewOf } from './session.mjs';
import { restartLater, servers, stop } from './servers.mjs';
import { register } from './registry.mjs';

const SINCE = new Date().toISOString();
const ID = randomUUID();

const USAGE = `Usage: node server.mjs [options]
  --root <dir>       the folder with the pages (default: the current folder)
  --port <n>         the port (default: 8765; 0: any free port)
  --data <dir>       the folder for the notes (default: <root>/.review)
  --agent <command>  the agent command (default: claude); a fake agent for tests
  --delay <seconds>  the agent starts by itself this long after the last new note (default: ${DELAY_MS / 1000})`;
const { values: opt } = parseArgs({
  options: { root: { type: 'string' }, port: { type: 'string', default: '8765' }, data: { type: 'string' },
    agent: { type: 'string', default: 'claude' }, delay: { type: 'string', default: String(DELAY_MS / 1000) }, help: { type: 'boolean', short: 'h' } },
});
if (opt.help) { console.log(USAGE); process.exit(0); }
if (!(+opt.delay >= 0)) { console.error(`--delay takes the seconds, 0 or more, not "${opt.delay}".`); process.exit(1); }

const TOOL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(opt.root ?? '.'), DATA = opt.data ? resolve(opt.data) : join(ROOT, '.review');
const TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm', '.md': 'text/plain', '.markdown': 'text/plain', '.txt': 'text/plain', '.csv': 'text/csv',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf',
};
const HTML = new Set(['.html', '.htm']), MARKDOWN = new Set(['.md', '.markdown']);
const PAGE = new Set([...HTML, ...MARKDOWN]);

// a path from the root with "/", as the pages and the notes name the files
const slash = p => p.split(sep).join('/');
const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const inside = (dir, f) => { const r = relative(dir, f); return !r.startsWith('..') && !isAbsolute(r); };
// a path for the agent: from the root when the file is in the root
const shown = f => (inside(ROOT, f) ? slash(relative(ROOT, f)) : f);

const store = await createStore(DATA);
// git ignores the data folder in any project, with no change to the .gitignore of the project
await writeFile(join(DATA, '.gitignore'), '*\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
// the values of the {placeholders} in agent.md; the url is known when the server listens
const vars = { notes: shown(join(DATA, 'notes.jsonl')), replies: shown(join(DATA, 'replies.json')), conventions: shown(join(TOOL, 'PAGES.md')), tool: shown(TOOL) };
const agent = createAgent({ root: ROOT, dir: DATA, store, vars, command: opt.agent, task: join(TOOL, 'agent.md'), delay: +opt.delay * 1000 });

// the notes with the short name of the agent that took each note
const notes = async () => (await store.notes()).map(n => (n.session ? { ...n, agent: agent.name(n.session) } : n));
// the session that changes the page now, else the session that changed it last; undefined when no agent touched the page
async function editorOf(page) {
  const mine = (await store.notes()).filter(n => n.page === page && n.session);
  const now = mine.find(n => n.status === 'wip');
  return (now || mine.sort((a, b) => String(a.started).localeCompare(String(b.started))).at(-1))?.session;
}

// The paths (from the root) that git ignores. None when the root is not in a git work tree or git is missing.
function ignoredOf(paths) {
  return new Promise(ok => {
    const git = spawn('git', ['check-ignore', '--stdin', '-z'], { cwd: ROOT, windowsHide: true });
    let out = '';
    git.stdout.on('data', d => { out += d; });
    git.on('error', () => ok(new Set()));
    git.on('close', () => ok(new Set(out.split('\0').filter(Boolean))));
    git.stdin.on('error', () => {});
    git.stdin.end(paths.map(p => p + '\0').join(''));
  });
}

// Every page (an HTML or a Markdown file) in the folder `dir` of the root, with its time, whether git ignores it,
// and its open notes: the count, the count in work, the time and the start of the newest one.
// Not in the list: dot folders (.git, the data folder), node_modules and the folder of this tool.
async function pages(dir = ROOT) {
  const files = [];
  async function walk(dir) {
    // a folder that cannot be read is left out
    for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const f = join(dir, d.name);
      if (d.isDirectory()) { if (!d.name.startsWith('.') && d.name !== 'node_modules' && f !== TOOL && f !== DATA) await walk(f); }
      else if (PAGE.has(extname(d.name).toLowerCase())) files.push(f);
    }
  }
  await walk(dir);
  const open = {};
  for (const n of await notes()) {
    if (CLOSED.has(n.status)) continue;
    const s = open[n.page] ??= { open: 0, wip: 0, noted: '' };
    s.open++;
    if (n.status === 'wip') s.wip++;
    if (n.time > s.noted) Object.assign(s, { noted: n.time, note: squash(n.text || (n.edit ? `Edit at line ${n.edit.line}` : '')).slice(0, 140) });
  }
  const paths = files.map(f => slash(relative(ROOT, f))), ignored = await ignoredOf(paths);
  return Promise.all(files.map(async (f, i) => {
    const path = paths[i];
    return { path, mtime: (await stat(f)).mtimeMs, ignored: ignored.has(path), open: 0, wip: 0, ...open[path] };
  }));
}

// the file of a URL path in the root, or null
function fileOf(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  const f = join(ROOT, normalize(p));
  return inside(ROOT, f) ? f : null;
}
const mtime = async f => (f && (await stat(f).catch(() => null))?.mtimeMs) || 0;

// The panel goes before the last </body>. The script tag tells the panel the page path and the models;
// dock: the panel stays open at the right side.
const esc = s => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function withPanel(html, page, dock = false) {
  const tag = `<script src="/__review/panel.js" data-page="${esc(page)}" data-models="${esc(JSON.stringify(MODELS))}"${dock ? ' data-dock' : ''}></script>`;
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at < 0 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

// the Markdown view of a file: the browser renders the file, and the panel stays open at the side
async function markdownPage(page) {
  const html = (await readFile(join(TOOL, 'markdown.html'), 'utf8'))
    .replace(/\{(page|models|project)\}/g, (m, k) => esc({ page, models: JSON.stringify(MODELS), project: basename(ROOT) }[k]));
  return withPanel(html, page, true);
}

// Put `after` in place of the lines `before` that start at the line `from` (from 0). The file can change after the browser
// read it: then `before` must occur in the file exactly once. Gives the new text and the line where `before` was, or null.
function replaceLines(text, from, before, after) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/), old = before.split('\n');
  const at = i => old.every((l, k) => lines[i + k] === l);
  let start = from;
  if (!at(start)) {
    const found = lines.map((l, i) => i).filter(at);
    if (found.length !== 1) return null;
    start = found[0];
  }
  lines.splice(start, old.length, ...(after ? after.split('\n') : []));
  return { text: lines.join(eol), from: start };
}

class HttpError extends Error { constructor(code, message) { super(message); this.code = code; } }
const LIMIT = 1 << 20;
async function json(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    if ((size += chunk.length) > LIMIT) throw new HttpError(413, 'the body is too big');
    chunks.push(chunk);
  }
  // decode the bytes together: a chunk can end in the middle of a character
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'the body is not JSON'); }
}
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Only this computer: the server listens on 127.0.0.1. A request with another Host is DNS rebinding.
// A change from a page of another site is refused: else any site could give a task to the agent.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
function guard(req) {
  if (!LOCAL.test(req.headers.host || '')) throw new HttpError(403, 'only localhost');
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'another origin');
}

// the edits of the files go one after another, so that two edits of one file do not lose one of them
let edits = Promise.resolve();
const serial = f => (edits = edits.then(f, f));

// the server stops: the notes of the agent go back to the queue on the next start
function quit(res) {
  agent.shutdown();
  res.on('finish', () => process.exit(0));
  send(res, 200, { quit: true });
}
const portOf = async url => {
  const port = +url.searchParams.get('port');
  const found = (await servers()).find(s => s.port === port);
  if (!found) throw new HttpError(400, 'not a registered review server');
  return found;
};

// the API of the panel and of the table of contents
const routes = {
  'GET /__review/panel.js': async (req, res) => send(res, 200, await readFile(join(TOOL, 'panel.js')), 'text/javascript'),
  'GET /__review/markdown.js': async (req, res) => send(res, 200, await readFile(join(TOOL, 'markdown.js')), 'text/javascript'),
  // the pages of a folder (dir: its path from the root; none: the root)
  'GET /__review/pages': async (req, res, url) => {
    const dir = fileOf(url.searchParams.get('dir') || '/');
    if (!dir || !(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(404, 'no such folder');
    send(res, 200, { root: ROOT, dir: slash(relative(ROOT, dir)), pages: await pages(dir) });
  },
  // servers.mjs finds the server of a folder by this answer, and stops it with quit
  'GET /__review/hello': async (req, res) => {
    const [list, status] = await Promise.all([store.notes(), agent.status()]);
    send(res, 200, { id: ID, root: ROOT, tool: TOOL, pid: process.pid, since: SINCE, agent: { state: status.state, text: status.text },
      open: list.filter(n => !CLOSED.has(n.status)).length });
  },
  'POST /__review/quit': async (req, res) => quit(res),
  // the review servers of this machine, for the table of contents; this server is `self`
  'GET /__review/servers': async (req, res) => send(res, 200, { self: server.address().port, servers: await servers() }),
  'POST /__review/servers/stop': async (req, res, url) => {
    const { port } = await portOf(url);
    if (port === server.address().port) return quit(res);
    send(res, 200, { stopped: await stop(port) });
  },
  'POST /__review/servers/restart': async (req, res, url) => {
    const a = await portOf(url), port = a.port;
    restartLater(a.root, port);
    send(res, 200, { restarting: true });
  },
  // the notes of a page, the time of its file and the agent status: the panel asks for them every few seconds
  'GET /__review/page': async (req, res, url) => {
    const page = url.searchParams.get('path') || '';
    const [list, time, status] = await Promise.all([notes(), mtime(fileOf(page)), agent.status()]);
    send(res, 200, { notes: list.filter(n => n.page === page), mtime: time, agent: status });
  },
  'POST /__review/notes': async (req, res) => {
    const n = await json(req);
    if (typeof n.page !== 'string' || typeof n.text !== 'string' || !n.text.trim()) throw new HttpError(400, 'a note needs a page and a text');
    // re: the id of the note that this note replies to
    if (n.re != null && !(await store.notes()).some(x => x.id === n.re)) throw new HttpError(400, 'no such note to reply to');
    const note = await store.add({ page: n.page, text: n.text.trim(), model: modelOf(n.model), ctx: n.ctx, el: n.el || undefined, sel: n.sel || undefined,
      re: n.re ?? undefined });
    agent.kick('new note');
    send(res, 200, note);
  },
  // An edit of a block in the Markdown view: the server changes the file at once, and the note asks the agent to finish the edit.
  // The text of the note is optional here. `note: false` ("Save only"): the server only changes the file.
  'POST /__review/edit': async (req, res) => {
    const e = await json(req);
    const f = typeof e.page === 'string' && MARKDOWN.has(extname(e.page).toLowerCase()) && fileOf(e.page);
    if (!f || !Number.isInteger(e.from) || typeof e.before !== 'string' || !e.before || typeof e.after !== 'string')
      throw new HttpError(400, 'an edit needs a Markdown page, a line and the text before and after');
    const before = e.before.replace(/\r\n/g, '\n'), after = e.after.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    const r = await serial(async () => {
      const text = await readFile(f, 'utf8'), done = replaceLines(text, e.from, before, after);
      if (!done) return { conflict: true, text };
      await writeFile(f, done.text);
      return done;
    });
    const fields = { page: e.page, text: String(e.text ?? '').trim(), model: modelOf(e.model), ctx: e.ctx };
    // The block changed since the browser read the file, most often because the agent edits this page now.
    // The reviewer already said what they want, so the agent merges the edit into the current text, in the session that changed the page.
    if (r.conflict) {
      const note = await store.add({ ...fields, to: await editorOf(e.page), edit: { line: e.from + 1, before, after, conflict: true } });
      agent.kick('edit of a changed block');
      return send(res, 200, { note, text: r.text, conflict: true });
    }
    if (e.note === false) return send(res, 200, { text: r.text });
    const note = await store.add({ ...fields, edit: { line: r.from + 1, before, after } });
    agent.kick('edit');
    send(res, 200, { note, text: r.text });
  },
  'DELETE /__review/notes': async (req, res, url) => {
    const r = await store.remove(url.searchParams.get('id'));
    send(res, r.error ? 409 : 200, r);
  },
  // "Looks good" on a closed note puts it into the archive of the panel; DELETE takes it back
  'POST /__review/accept': async (req, res, url) => {
    const r = await store.accept(url.searchParams.get('id'), true);
    send(res, r.error ? 409 : 200, r);
  },
  'DELETE /__review/accept': async (req, res, url) => {
    const r = await store.accept(url.searchParams.get('id'), false);
    send(res, r.error ? 409 : 200, r);
  },
  // the session page (session.html): what an agent session did, step by step, and what it spent
  'GET /__review/session': async (req, res) => send(res, 200, await readFile(join(TOOL, 'session.html')), 'text/html'),
  // the view of the session log; key: the key of the last answer, the page asks every few seconds and gets {same: true} when nothing changed
  'GET /__review/session/log': async (req, res, url) => {
    const id = url.searchParams.get('id') || '';
    if (!/^[\w-]{1,64}$/.test(id)) throw new HttpError(400, 'not a session id');
    const text = await readFile(agent.log(id), 'utf8').catch(() => '');
    const live = agent.live(id), key = `${text.length}:${live}`;
    if (url.searchParams.get('key') === key) return send(res, 200, { same: true, key, now: Date.now() });
    const view = viewOf(parseLog(text), { live });
    const ids = new Set(view.tasks.flatMap(x => x.ids));
    const about = (await store.notes()).filter(n => ids.has(n.id))
      .map(n => ({ id: n.id, page: n.page, status: n.status, text: squash(n.text || (n.edit ? `Edit at line ${n.edit.line}` : '')).slice(0, 200) }));
    send(res, 200, { key, now: Date.now(), session: id, name: agent.name(id) || null, live, limit: agent.limit, found: !!text, notes: about, ...view });
  },
  'GET /__review/agent': async (req, res) => send(res, 200, await agent.status()),
  'POST /__review/agent/start': async (req, res) => { await agent.start(); send(res, 200, await agent.status()); },
  'POST /__review/agent/stop': async (req, res) => { agent.stop(); send(res, 200, await agent.status()); },
};

// the files of the root; an HTML page gets the panel, a Markdown file opens in the Markdown view,
// a folder gives the table of contents of the folder (an index.html opens by its name). `?raw` gives the Markdown file itself.
async function file(req, res, url) {
  const f = fileOf(url.pathname);
  const info = f && await stat(f).catch(() => null);
  if (info?.isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(301, { location: url.pathname + '/' + url.search }); return res.end(); }
    return send(res, 200, await readFile(join(TOOL, 'index.html')), 'text/html');
  }
  if (!info?.isFile()) {
    // a page with no icon: no 404 in the console of each page
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    return send(res, 404, 'Not found', 'text/plain');
  }
  const ext = extname(f).toLowerCase();
  const data = await readFile(f);
  // a page in a frame or a page that a script loads gets no panel: only the page in the tab has it
  const dest = req.headers['sec-fetch-dest'];
  const top = !dest || dest === 'document', page = slash(relative(ROOT, f));
  if (HTML.has(ext) && top) return send(res, 200, withPanel(data.toString('utf8'), page), 'text/html');
  if (MARKDOWN.has(ext) && top && !url.searchParams.has('raw')) return send(res, 200, await markdownPage(page), 'text/html');
  send(res, 200, data, TYPES[ext] || 'application/octet-stream');
}

const server = createServer(async (req, res) => {
  try {
    guard(req);
    const url = new URL(req.url, 'http://localhost');
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, url);
    if (url.pathname.startsWith('/__review/')) throw new HttpError(404, 'no such API');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'only GET');
    await file(req, res, url);
  } catch (e) {
    if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
});
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `The port ${opt.port} is in use: stop the other server or use --port.` : e.message);
  process.exit(1);
});
server.listen(+opt.port, '127.0.0.1', async () => {
  try {
    const unregister = register({ id: ID, root: ROOT, pid: process.pid, since: SINCE, port: server.address().port });
    process.on('exit', unregister);
  } catch (e) { console.error(e.message); process.exit(1); }
  vars.url = `http://localhost:${server.address().port}/`;
  console.log(`Review server: ${vars.url}`);
  console.log(`Pages: ${ROOT}\nNotes: ${DATA}`);
  await agent.init();
});
// Ctrl+C stops the agent too; its notes go back to the queue on the next start
process.on('SIGINT', () => { agent.shutdown(); process.exit(130); });
process.on('SIGTERM', () => { agent.shutdown(); process.exit(143); });
