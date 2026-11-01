// The server, the store and the agent queue, with a fake agent. Run: npm test (in the repo folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server.mjs'), FAKE = join(HERE, 'fake-agent.mjs');

// a folder with pages and a server on a free port; mode: the mode of the fake agent
async function serve(t, mode = 'fix') {
  const base = mkdtempSync(join(tmpdir(), 'review-')), root = join(base, 'root');
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  put('a.html', '<!doctype html><title>A</title><body><h1>A</h1></body>');
  put('sub/b.html', '<p>no body tag');
  put('sub/index.html', '<body>index</body>');
  put('.hidden/c.html', '');
  put('node_modules/d.html', '');
  put('secret.txt', 'secret');
  put('doc.md', '# Doc\r\n\r\nOne line.\r\nTwo line.\r\n\r\n- item\r\n');
  const child = spawn(process.execPath, [SERVER, '--root', root, '--port', '0', '--agent', `"${process.execPath}" "${FAKE}"`],
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
  // the block is not in the file now
  assert.equal((await edit({ page: 'doc.md', from: 2, before: 'One line.', after: 'x' })).code, 409);
  // an edit of an HTML page or of a file out of the root
  assert.equal((await edit({ page: 'a.html', from: 0, before: 'x', after: 'y' })).code, 400);
  assert.equal((await edit({ page: '../outside.md', from: 0, before: 'x', after: 'y' })).code, 400);
  // the agent ends its task before the folder goes
  await until(async () => (await page(s, 'doc.md')).notes.every(n => n.cost));
});
