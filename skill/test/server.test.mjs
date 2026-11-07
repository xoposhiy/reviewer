// The server, the store and the agent queue, with a fake agent. Run: npm test (in the repo folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextTask, STAY_MS } from '../queue.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs'), FAKE = join(HERE, 'fake-agent.mjs');

// a folder with pages and a server on a free port; mode: the mode of the fake agent;
// delay: the seconds from the last new note to the start by itself (0: at once)
async function serve(t, mode = 'fix', { delay = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'review-')), root = join(base, 'root');
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put('a.html', '<!doctype html><title>A</title><body><h1>A</h1></body>');
  put('sub/b.html', '<p>no body tag');
  put('sub/index.html', '<body>index</body>');
  put('.hidden/c.html', '');
  put('node_modules/d.html', '');
  put('secret.txt', 'secret');
  put('doc.md', '# Doc\r\n\r\nOne line.\r\nTwo line.\r\n\r\n- item\r\n');
  const child = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', '--delay', String(delay), '--agent', `"${process.execPath}" "${FAKE}"`],
    { env: { ...process.env, FAKE_AGENT: mode }, windowsHide: true });
  const exited = new Promise(ok => child.on('exit', ok));
  let url;
  // quit, not kill: the server kills its agent too, and on Windows a running agent keeps the folder from deletion
  t.after(async () => {
    if (url && child.exitCode === null) await fetch(url + '__review/quit', { method: 'POST' }).catch(() => {});
    await Promise.race([exited, new Promise(ok => setTimeout(ok, 5000))]);
    child.kill();
    rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  });
  url = await new Promise((ok, fail) => {
    let out = '';
    child.stdout.on('data', d => { out += d; const m = out.match(/Review server: (\S+)/); if (m) ok(m[1]); });
    child.on('exit', code => fail(new Error(`the server exited: ${code}`)));
  });
  const api = async (path, init) => {
    const r = await fetch(url + path, init);
    return { code: r.status, body: r.headers.get('content-type').startsWith('application/json') ? await r.json() : await r.text() };
  };
  const note = (body, headers = {}) =>
    api('__review/notes', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, url, api, note };
}

// wait until f gives a true value
async function until(f, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(ok => setTimeout(ok, 100))) {
    const v = await f();
    if (v) return v;
  }
  throw new Error('timeout');
}
async function page(s, path) {
  const r = await s.api('__review/page?path=' + encodeURIComponent(path));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  return r.body;
}

// a raw request: fetch() removes ".." from the path itself
const raw = (url, path, headers = {}) => new Promise((ok, fail) => {
  const { hostname, port } = new URL(url);
  request({ hostname, port, path, headers }, r => { r.resume(); ok(r.statusCode); }).on('error', fail).end();
});

test('pages get the panel; other files and frames do not', async t => {
  const s = await serve(t, 'idle');
  const a = (await s.api('a.html')).body;
  assert.match(a, /<script src="\/__review\/panel\.js" data-page="a\.html" data-models="[^"]+"><\/script><\/body>/);
  assert.match((await s.api('sub/b.html')).body, /<p>no body tag<script src="\/__review\/panel\.js" data-page="sub\/b\.html"/);
  assert.doesNotMatch((await s.api('a.html', { headers: { 'sec-fetch-dest': 'iframe' } })).body, /panel\.js/);
  assert.match((await s.api('__review/panel.js')).body, /reviewState/);
  // a folder gives the table of contents, also with an index.html; the index.html opens by its name
  assert.match((await s.api('sub/')).body, /<title>Review<\/title>/);
  assert.match((await s.api('sub/index.html')).body, /data-page="sub\/index\.html"/);
  assert.equal((await fetch(s.url + 'sub', { redirect: 'manual' })).status, 301);
});

test('the table of contents of a folder lists only the pages of the folder', async t => {
  const s = await serve(t, 'idle');
  const sub = (await s.api('__review/pages?dir=sub')).body;
  assert.equal(sub.dir, 'sub');
  assert.deepEqual(sub.pages.map(p => p.path).sort(), ['sub/b.html', 'sub/index.html']);
  assert.equal((await s.api('__review/pages?dir=nothing')).code, 404);
  assert.equal((await s.api('__review/pages?dir=..')).code, 404);
});

test('hello names the root and the open notes; git ignores the data folder', async t => {
  const s = await serve(t, 'idle');
  await s.note({ page: 'a.html', text: 'one' });
  const hello = (await s.api('__review/hello')).body;
  assert.equal(hello.root, s.root);
  assert.equal(hello.open, 1);
  assert.ok(hello.pid && hello.since && hello.agent.state);
  assert.equal(readFileSync(join(s.root, '.review', '.gitignore'), 'utf8'), '*\n');
  assert.equal((await s.api('__review/servers/stop?port=1', { method: 'POST' })).code, 400);
});

test('no file out of the root, no request from another site', async t => {
  const s = await serve(t, 'idle');
  writeFileSync(join(s.root, '..', 'outside.txt'), 'x');
  assert.equal(await raw(s.url, '/..%2foutside.txt'), 404);
  assert.equal(await raw(s.url, '/%2e%2e/outside.txt'), 404);
  assert.equal(await raw(s.url, '/a.html', { host: 'evil.example' }), 403);
  assert.equal((await s.note({ page: 'a.html', text: 'x' }, { origin: 'http://evil.example' })).code, 403);
  assert.equal((await s.note({ page: 'a.html', text: '  ' })).code, 400);
});

test('a long note in Cyrillic comes whole: the body comes in many chunks', async t => {
  const s = await serve(t, 'idle');
  const text = 'Сделай слайд проще. '.repeat(5000);
  assert.equal((await s.note({ page: 'a.html', text })).body.text, text.trim());
  assert.equal((await page(s, 'a.html')).notes[0].text, text.trim());
});

test('the table of contents lists the pages without dot folders and node_modules', async t => {
  const s = await serve(t, 'idle');
  const { pages } = (await s.api('__review/pages')).body;
  assert.deepEqual(pages.map(p => p.path).sort(), ['a.html', 'doc.md', 'sub/b.html', 'sub/index.html']);
  assert.match((await s.api('')).body, /<title>Review<\/title>/);
});

test('the table of contents tells the open notes of each page and the pages that git ignores', async t => {
  const s = await serve(t, 'idle');
  writeFileSync(join(s.root, '.gitignore'), 'sub/\n');
  const git = spawnSync('git', ['init', '-q'], { cwd: s.root });
  await s.api('__review/agent/stop', { method: 'POST' });
  await s.note({ page: 'a.html', text: 'first' });
  await s.note({ page: 'a.html', text: 'second\n  note' });
  const pages = Object.fromEntries((await s.api('__review/pages')).body.pages.map(p => [p.path, p]));
  assert.equal(pages['a.html'].open, 2);
  assert.equal(pages['a.html'].wip, 0);
  assert.equal(pages['a.html'].note, 'second note');
  assert.equal(pages['doc.md'].open, 0);
  if (git.status === 0) assert.deepEqual(Object.values(pages).filter(p => p.ignored).map(p => p.path).sort(), ['sub/b.html', 'sub/index.html']);
});

test('the agent fixes the notes one task after another and resumes its session', async t => {
  const s = await serve(t, 'fix');
  const sel = { text: 'the selected text', path: 'p#intro' };
  const n1 = (await s.note({ page: 'a.html', text: 'one', model: 'opus', ctx: { where: 'A', hash: 'a' }, sel })).body;
  assert.equal(n1.id, 'n1');
  const fixed = await until(async () => (await page(s, 'a.html')).notes.find(n => n.id === 'n1' && n.cost));
  assert.equal(fixed.status, 'fixed');
  assert.equal(fixed.reply, 'done');
  assert.equal(fixed.cost, 0.5);
  assert.equal(fixed.ms, 3000);
  assert.equal(fixed.agent, 'a1');
  assert.deepEqual(fixed.ctx, { where: 'A', hash: 'a' });
  assert.deepEqual(fixed.sel, sel);
  // the next note of the same model goes to the same session
  await s.note({ page: 'a.html', text: 'two', model: 'unknown model' });
  const second = await until(async () => (await page(s, 'a.html')).notes.find(n => n.id === 'n2' && n.cost));
  assert.equal(second.model, 'opus');
  assert.equal(second.session, fixed.session);
  // the id of a deleted note is not used again
  assert.equal((await s.api('__review/notes?id=n2', { method: 'DELETE' })).code, 200);
  assert.deepEqual((await page(s, 'a.html')).notes.map(n => n.id), ['n1']);
  assert.equal(JSON.parse(readFileSync(join(s.root, '.review', 'replies.json'), 'utf8')).n2, undefined);
  assert.equal((await s.note({ page: 'a.html', text: 'three' })).body.id, 'n3');
});

test('an agent that closes no note stops the queue with an error', async t => {
  const s = await serve(t, 'idle');
  await s.note({ page: 'a.html', text: 'one' });
  const agent = await until(async () => { const a = (await s.api('__review/agent')).body; return a.state === 'error' && a; });
  assert.match(agent.text, /the agent closed no note/);
  assert.equal(agent.action, 'start');
});

test('Stop kills the agent; its note goes back to the queue and cannot be deleted while in work', async t => {
  const s = await serve(t, 'hang');
  await s.note({ page: 'a.html', text: 'one', model: 'sonnet' });
  await until(async () => (await page(s, 'a.html')).notes[0].status === 'wip');
  const busy = await s.api('__review/notes?id=n1', { method: 'DELETE' });
  assert.equal(busy.code, 409);
  assert.match((await s.api('__review/agent')).body.text, /^Σ a1 works on n1/);
  await s.api('__review/agent/stop', { method: 'POST' });
  const back = await until(async () => { const n = (await page(s, 'a.html')).notes[0]; return n.status === 'open' && n; });
  assert.match(back.reply, /stopped before the end \(button\)/);
  assert.equal(back.tries, 0);
  assert.equal((await s.api('__review/agent')).body.state, 'stopped');
});

test('a Markdown file opens in the Markdown view with the docked panel; ?raw gives the file', async t => {
  const s = await serve(t, 'idle');
  const view = (await s.api('doc.md')).body;
  assert.match(view, /<script src="\/__review\/markdown\.js" data-page="doc\.md" data-models="[^"]+" data-project="root">/);
  assert.match(view, /<script src="\/__review\/panel\.js" data-page="doc\.md" data-models="[^"]+" data-dock><\/script>/);
  assert.match((await s.api('__review/markdown.js')).body, /markdownit/);
  assert.match((await s.api('doc.md?raw')).body, /^# Doc\r\n/);
  assert.match((await s.api('doc.md', { headers: { 'sec-fetch-dest': 'empty' } })).body, /^# Doc/);
});

test('an edit changes the Markdown file at once and becomes a note for the agent', async t => {
  const s = await serve(t, 'fix');
  const edit = body => s.api('__review/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const file = () => readFileSync(join(s.root, 'doc.md'), 'utf8');
  const r = await edit({ page: 'doc.md', from: 2, before: 'One line.\nTwo line.', after: 'Одна строка.\n\n', model: 'sonnet', ctx: { where: 'Doc', hash: 'doc' } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  // the line ends of the file stay; the empty lines at the end of the edit go
  assert.equal(file(), '# Doc\r\n\r\nОдна строка.\r\n\r\n- item\r\n');
  assert.equal(r.body.text, file());
  assert.deepEqual(r.body.note.edit, { line: 3, before: 'One line.\nTwo line.', after: 'Одна строка.' });
  assert.equal(r.body.note.text, '');
  const fixed = await until(async () => (await page(s, 'doc.md')).notes.find(n => n.status === 'fixed'));
  assert.equal(fixed.model, 'sonnet');
  // the block moved: its text occurs once, so the edit finds it
  assert.equal((await edit({ page: 'doc.md', from: 0, before: '- item', after: '- point' })).code, 200);
  assert.match(file(), /- point\r\n$/);
  // an edit of an HTML page or of a file out of the root
  assert.equal((await edit({ page: 'a.html', from: 0, before: 'x', after: 'y' })).code, 400);
  assert.equal((await edit({ page: '../outside.md', from: 0, before: 'x', after: 'y' })).code, 400);
  // the agent ends its task before the folder goes
  await until(async () => (await page(s, 'doc.md')).notes.every(n => n.cost));
});

test('an edit of a block that changed meanwhile goes to the agent that changed the page; the file stays', async t => {
  const s = await serve(t, 'fix');
  const edit = body => s.api('__review/edit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const file = () => readFileSync(join(s.root, 'doc.md'), 'utf8');
  await s.note({ page: 'doc.md', text: 'one' });
  const first = await until(async () => (await page(s, 'doc.md')).notes.find(n => n.cost));
  const before = file();
  for (const body of [{ model: 'opus' }, { note: false }]) {
    const r = await edit({ page: 'doc.md', from: 2, before: 'Old line.', after: 'New line.', ...body });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(r.body.conflict, true);
    assert.equal(r.body.text, before);
    assert.deepEqual(r.body.note.edit, { line: 3, before: 'Old line.', after: 'New line.', conflict: true });
    assert.equal(r.body.note.to, first.session);
  }
  assert.equal(file(), before);
  const notes = await until(async () => { const l = (await page(s, 'doc.md')).notes; return l.length === 3 && l.every(n => n.cost) && l; });
  assert.ok(notes.every(n => n.session === first.session));
});

// ---- The start by itself, the queue, replies and "Looks good" ----

const sleep = ms => new Promise(ok => setTimeout(ok, ms));
const agentOf = async s => (await s.api('__review/agent')).body;
const fix = s => s.api('__review/agent/start', { method: 'POST' });
// the notes of the page, when each of them has the cost of its task: the tasks ended
const done = (s, path = 'a.html') => until(async () => { const l = (await page(s, path)).notes; return l.every(n => n.cost) && l; });
const at = hash => ({ where: hash, hash });

test('a new note waits for Fix; Stop turns the start by itself off', async t => {
  const s = await serve(t, 'fix', { delay: 60 });
  await s.note({ page: 'a.html', text: 'one' });
  let a = await agentOf(s);
  assert.equal(a.state, 'idle');
  assert.equal(a.open, 1);
  assert.ok(a.autoIn > 50_000 && a.autoIn <= 60_000, String(a.autoIn));
  await sleep(300);
  assert.equal((await page(s, 'a.html')).notes[0].status, 'open');
  await fix(s);
  assert.equal((await done(s))[0].status, 'fixed');
  await s.api('__review/agent/stop', { method: 'POST' });
  await s.note({ page: 'a.html', text: 'two' });
  a = await agentOf(s);
  assert.equal(a.state, 'stopped');
  assert.equal(a.autoIn, null);
  assert.equal(a.open, 1);
  await fix(s);
  assert.equal((await done(s))[1].status, 'fixed');
});

test('the agent starts by itself after the last new note and takes the notes at one place in one task', async t => {
  const s = await serve(t, 'fix', { delay: 2 });
  await s.note({ page: 'a.html', text: 'one', ctx: at('a') });
  await sleep(1000);
  await s.note({ page: 'a.html', text: 'two', ctx: at('a') });
  // the second note started the count again
  assert.ok((await agentOf(s)).autoIn > 1500);
  assert.ok((await page(s, 'a.html')).notes.every(n => n.status === 'open'));
  const [one, two] = await done(s);
  assert.equal(one.status, 'fixed');
  assert.equal(one.started, two.started);
  assert.equal(one.cost, 0.25);
});

test('Opus takes a Sonnet note at the place of its own note; Sonnet takes its notes at other places', async t => {
  const s = await serve(t, 'fix', { delay: 60 });
  await s.note({ page: 'a.html', text: 's1', model: 'sonnet', ctx: at('x') });
  await s.note({ page: 'a.html', text: 'o2', model: 'opus', ctx: at('x') });
  await s.note({ page: 'a.html', text: 's3', model: 'sonnet', ctx: at('y') });
  await fix(s);
  const [s1, o2, s3] = await done(s);
  assert.equal(s1.started, o2.started);
  const { by } = JSON.parse(readFileSync(join(s.root, '.review', 'agent.json'), 'utf8'));
  assert.equal(by.opus.session, o2.session);
  assert.equal(by.sonnet.session, s3.session);
  assert.notEqual(s3.session, o2.session);
});

test('a reply goes to the session that closed its note', async t => {
  const s = await serve(t, 'fix');
  await s.note({ page: 'a.html', text: 'one', model: 'opus' });
  const [n1] = await done(s);
  assert.equal((await s.note({ page: 'a.html', text: 'more', re: 'n9' })).code, 400);
  const reply = (await s.note({ page: 'a.html', text: 'more', model: 'sonnet', re: 'n1' })).body;
  assert.equal(reply.re, 'n1');
  const [, n2] = await done(s);
  assert.equal(n2.status, 'fixed');
  assert.equal(n2.session, n1.session);
});

test('"Looks good" accepts a closed note and keeps its status; DELETE takes it back', async t => {
  const s = await serve(t, 'fix', { delay: 60 });
  const accept = (id, method = 'POST') => s.api('__review/accept?id=' + id, { method });
  await s.note({ page: 'a.html', text: 'one' });
  assert.equal((await accept('n1')).code, 409);
  assert.equal((await accept('n9')).code, 409);
  await fix(s);
  await done(s);
  const r = await accept('n1');
  assert.equal(r.code, 200);
  const [n1] = (await page(s, 'a.html')).notes;
  assert.equal(n1.status, 'fixed');
  assert.equal(n1.accepted, r.body.accepted);
  assert.equal((await accept('n1', 'DELETE')).code, 200);
  assert.equal((await page(s, 'a.html')).notes[0].accepted, undefined);
});

// ---- The queue alone (queue.mjs) ----

const T0 = Date.parse('2026-01-01T10:00:00Z');
// an open note of the page a.html: the id, the model, the hash of its place and the minute when the reviewer wrote it
const q = (id, model, place, min = +id.slice(1), more = {}) =>
  ({ id, model, page: 'a.html', ctx: at(place), time: new Date(T0 + min * 60_000).toISOString(), status: 'open', ...more });
// the model and the note ids of the next task
const next = (notes, options = {}) => {
  const task = nextTask(notes, { models: ['opus', 'sonnet'], ...options });
  return task && [task.model, ...task.notes.map(n => n.id)];
};

test('the queue: with no warm model, the oldest note chooses the model', () => {
  assert.equal(next([]), null);
  assert.equal(next([q('n1', 'opus', 'x', 1, { status: 'fixed' })]), null);
  assert.deepEqual(next([q('n1', 'sonnet', 'x'), q('n2', 'opus', 'y')]), ['sonnet', 'n1']);
  // the notes of one model at other places wait for their own tasks
  assert.deepEqual(next([q('n1', 'opus', 'x'), q('n2', 'opus', 'y'), q('n3', 'opus', 'x')]), ['opus', 'n1', 'n3']);
});

test('the queue: the warm model keeps the turn, unless the other model waits too long', () => {
  assert.deepEqual(next([q('n1', 'sonnet', 'x'), q('n2', 'opus', 'y')], { warm: 'opus' }), ['opus', 'n2']);
  const late = 1 + STAY_MS / 60_000 + 1;
  assert.deepEqual(next([q('n1', 'sonnet', 'x'), q('n2', 'opus', 'y', late)], { warm: 'opus' }), ['sonnet', 'n1']);
  // the warm model has no note to start with
  assert.deepEqual(next([q('n1', 'opus', 'x')], { warm: 'sonnet' }), ['opus', 'n1']);
});

test('the queue: Opus takes the Sonnet notes at its place, up to 3 notes; Sonnet never takes an Opus note', () => {
  const notes = [q('n1', 'sonnet', 'x'), q('n2', 'opus', 'x'), q('n3', 'sonnet', 'x'), q('n4', 'sonnet', 'x')];
  assert.deepEqual(next(notes, { warm: 'sonnet' }), ['opus', 'n2', 'n1', 'n3']);
  // with no Opus note at the place, the Sonnet notes go to Sonnet
  assert.deepEqual(next([q('n1', 'sonnet', 'x'), q('n2', 'opus', 'y')], { warm: 'sonnet' }), ['sonnet', 'n1']);
  // a reply that goes to Sonnet starts a Sonnet task; the task does not take the Opus note at its place
  const closed = q('n1', 'sonnet', 'x', 1, { status: 'fixed', session: 'S' }), reply = q('n2', 'sonnet', 'x', 2, { re: 'n1' });
  assert.deepEqual(next([closed, reply, q('n3', 'opus', 'x')], { sessions: { sonnet: 'S' }, warm: 'sonnet' }), ['sonnet', 'n2']);
});

test('the queue: a reply goes to the session that closed its note while that session is current', () => {
  const closed = q('n1', 'opus', 'x', 1, { status: 'fixed', session: 'A' }), reply = q('n2', 'sonnet', 'y', 2, { re: 'n1' });
  assert.deepEqual(next([closed, reply], { sessions: { opus: 'A' } }), ['opus', 'n2']);
  // the session of Opus is new: the reply goes by its own model
  assert.deepEqual(next([closed, reply], { sessions: { opus: 'B' } }), ['sonnet', 'n2']);
  // Opus does not take a reply that goes to the session of Sonnet
  const bySonnet = { ...closed, session: 'S' }, opusHere = q('n3', 'opus', 'y');
  assert.deepEqual(next([bySonnet, reply, opusHere], { sessions: { sonnet: 'S' } }), ['sonnet', 'n2']);
  assert.deepEqual(next([bySonnet, { ...reply, status: 'wip' }, opusHere], { sessions: { sonnet: 'S' } }), ['opus', 'n3']);
});

test('the queue: a reply sent with a stronger model than the session that closed its note goes to the stronger model', () => {
  const bySonnet = q('n1', 'sonnet', 'x', 1, { status: 'fixed', session: 'S' }), reply = q('n2', 'opus', 'x', 2, { re: 'n1' });
  assert.deepEqual(next([bySonnet, reply], { sessions: { sonnet: 'S', opus: 'A' }, warm: 'sonnet' }), ['opus', 'n2']);
  // a weaker model stays with the session: the closed note was done by Opus
  const byOpus = { ...bySonnet, session: 'A' };
  assert.deepEqual(next([byOpus, { ...reply, model: 'sonnet' }], { sessions: { sonnet: 'S', opus: 'A' } }), ['opus', 'n2']);
});

test('"Save only" changes the Markdown file and makes no note, so the agent does not start', async t => {
  const s = await serve(t, 'fix');
  const r = await s.api('__review/edit', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 'doc.md', from: 2, before: 'One line.\nTwo line.', after: 'One line.', note: false }) });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(readFileSync(join(s.root, 'doc.md'), 'utf8'), '# Doc\r\n\r\nOne line.\r\n\r\n- item\r\n');
  assert.equal(r.body.text, readFileSync(join(s.root, 'doc.md'), 'utf8'));
  assert.equal(r.body.note, undefined);
  const { notes, agent } = await page(s, 'doc.md');
  assert.deepEqual(notes, []);
  assert.equal(agent.state, 'idle');
});
