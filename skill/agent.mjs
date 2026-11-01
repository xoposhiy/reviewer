// The review agent: a headless Claude Code that fixes the open notes. agent.md is its task: up to 3 related notes at a time.
// It starts on the Start button or on a new note, then takes task after task while open notes exist.
// Each note names a model, Opus (Ω) or Sonnet (Σ); a task runs with the model of the oldest open note.
// Each model has its own session: the next task of the model resumes it, until its context reaches MAX_TOKENS.
// When an agent exits, hangs or the server restarts, the notes that the agent left in `wip` go back to the queue.
// After MAX_TRIES such stops a note becomes `stuck`, and the agents skip it.
// The cost and the time of a task are split equally between the notes of the task (the fields `cost`, `ms`, `sessions`).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { CLOSED } from './store.mjs';

const MAX_TOKENS = 100_000, HUNG_MS = 15 * 60_000, MAX_TRIES = 2, NEXT_TASK_MS = 2000;
// the models (the aliases of `claude --model`) and their letters in the panel; the first one is the default
export const MODELS = { opus: 'Ω', sonnet: 'Σ' };
export const modelOf = m => (Object.hasOwn(MODELS, m) ? m : Object.keys(MODELS)[0]);

const kTokens = n => `${Math.round(n / 1000)}k tokens`;
const clock = t => new Date(t).toLocaleTimeString('en-GB');
const ids = entries => entries.map(([id]) => id).join(', ');
// "node fake agent.mjs" → ['node', 'fake agent.mjs']: quotes keep a path with spaces in one argument
const words = s => s.match(/"[^"]*"|\S+/g).map(w => w.replace(/^"(.*)"$/, '$1'));

// root: the project folder (the agent works there); dir: the data folder; task: the file of the task;
// vars: the values of the {placeholders} in the task; command: the agent command, `claude` or a fake agent for tests
export function createAgent({ root, dir, store, task, vars, command = 'claude' }) {
  const STATE = join(dir, 'agent.json'), LOG = join(dir, 'agent.log');
  const [cmd, ...pre] = words(command);
  // by: the session of each model and its context size, {opus: {session, tokens}, ...};
  // names: the short name of each session (a1, a2, ...), so that the panel shows which agent works on a note
  const saved = { by: {}, names: {}, next: 1, ...(existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}) };
  const slot = model => (saved.by[model] ||= { session: null, tokens: 0 });
  const name = session => saved.names[session];
  const save = () => writeFile(STATE, JSON.stringify(saved, null, 2));
  // auto: a new note starts the agent; the Stop button turns it off
  let run = null, starting = false, auto = true, error = '';
  const log = [];

  function say(s) {
    const line = `${clock(Date.now())} ${run ? `${MODELS[run.model]} ${run.name} ` : ''}${s}`;
    log.push(line);
    if (log.length > 200) log.shift();
    console.log('[agent] ' + line);
    appendFile(LOG, line + '\n').catch(() => {});
  }

  // The notes that a stopped agent left in `wip` go back to the queue; session null: the notes of every agent.
  // tried: the stop counts as a failed try.
  const release = (session, why, tried) => store.updateReplies(all => {
    const back = Object.entries(all).filter(([, r]) => r.status === 'wip' && (!session || r.session === session));
    for (const [, r] of back) {
      r.tries = (r.tries || 0) + (tried ? 1 : 0);
      r.status = r.tries >= MAX_TRIES ? 'stuck' : 'open';
      r.reply = `Agent ${name(r.session) || '?'} stopped before the end (${why}). ` +
        (r.status === 'stuck' ? 'The agents skip this note now: a person must look at it.' : 'The note is back in the queue.');
    }
    if (back.length) say(`${ids(back)} back to the queue (${why})`);
  });

  // The cost and the time of a task go to its notes in equal parts, also when the task did not finish.
  // The notes of a task have its session and its start time: the agent writes them when it takes the notes.
  const account = r => store.updateReplies(all => {
    const mine = Object.entries(all).filter(([, x]) => x.session === r.session && x.started === r.started);
    if (!mine.length) return;
    const ms = Number.isFinite(r.ms) ? r.ms : Date.now() - Date.parse(r.started);
    for (const [, x] of mine) {
      x.ms = Math.round((x.ms || 0) + ms / mine.length);
      if (Number.isFinite(r.cost)) x.cost = +((x.cost || 0) + r.cost / mine.length).toFixed(4);
      x.sessions = [...new Set([...(x.sessions || []), r.session])];
    }
    say(`${ids(mine)}: ${Number.isFinite(r.cost) ? `$${r.cost.toFixed(2)}, ` : ''}${Math.round(ms / 1000)} s`);
  });

  const closedIds = async () => new Set((await store.notes()).filter(n => CLOSED.has(n.status)).map(n => n.id));

  // one event of `claude -p --output-format stream-json`
  function onEvent(e) {
    run.last = Date.now();
    if (e.type === 'assistant') {
      const u = e.message.usage || {};
      run.slot.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const c of e.message.content || []) {
        if (c.type === 'text' && c.text.trim()) say(c.text.trim().replace(/\s+/g, ' ').slice(0, 300));
        if (c.type === 'tool_use') {
          const i = c.input || {};
          const arg = i.file_path ? relative(root, i.file_path).replaceAll('\\', '/') : i.command || i.pattern || i.description || i.skill || '';
          say(`${c.name} ${String(arg).replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
    }
    // the cost (USD) and the time of this task: a resumed session reports only this task
    if (e.type === 'result') {
      run.cost = e.total_cost_usd;
      run.ms = e.duration_ms;
      if (e.is_error) error = String(e.result || e.subtype).slice(0, 300);
    }
  }

  async function start(why) {
    if (run || starting || !auto) return;
    starting = true;
    try {
      const first = (await store.notes()).find(n => n.status === 'open');
      if (!first) return;
      const model = modelOf(first.model), my = slot(model);
      const resume = !!my.session, session = my.session || randomUUID(), started = new Date().toISOString();
      const values = { ...vars, session, time: started };
      const prompt = (await readFile(task, 'utf8')).replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);
      const closed = await closedIds();
      const env = { ...process.env };
      delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;  // the agent is not a nested Claude Code
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--model', model, resume ? '--resume' : '--session-id', session];
      // from here on, no await until the handlers are set: the agent can exit at once
      // detached: on Linux and macOS, kill() stops the whole process group of the agent
      const child = spawn(cmd, [...pre, ...args], { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32' });
      saved.names[session] ||= `a${saved.next++}`;
      my.session = session;
      error = '';
      run = { child, model, session, started, slot: my, name: name(session), last: Date.now(), closed, stopped: null };
      save().catch(e => say('state not saved: ' + e.message));
      say(`start (${why}): ${model}, ${resume ? 'same agent' : 'new agent'}, session ${session.slice(0, 8)}, ${kTokens(my.tokens)}`);
      child.stdin.on('error', () => {});  // the agent can exit before it reads the task
      child.stdin.end(prompt);
      createInterface({ input: child.stdout }).on('line', l => { try { onEvent(JSON.parse(l)); } catch { } });
      child.stderr.on('data', d => appendFile(LOG, d).catch(() => {}));
      let ended = false;
      const end = code => { if (!ended) { ended = true; finish(code); } };
      child.on('error', e => { error = e.message; end(-1); });
      child.on('close', end);
    } catch (e) {
      // no one awaits a start on a new note: an error here must not stop the server
      error = e.message;
      say('error: ' + error);
    } finally { starting = false; }
  }

  async function finish(code) {
    const r = run;
    const why = r.stopped || (code === 0 ? 'the task ended' : `exit ${code}`);
    let closed = 0;
    // whatever fails here, the run ends: else the agent shows "works" forever
    try {
      await account(r).catch(e => say('cost not saved: ' + e.message));
      await release(r.session, why, r.stopped !== 'button');
      // the notes that this task closed (compare the ids: the reviewer can delete a closed note during the task)
      closed = [...await closedIds()].filter(id => !r.closed.has(id)).length;
      say(`end: ${why}, ${closed} note(s) closed, ${kTokens(r.slot.tokens)}`);
      if (r.slot.tokens >= MAX_TOKENS) say(`the session is full: the next ${r.model} task goes to a new agent`);
      if (code !== 0 || r.slot.tokens >= MAX_TOKENS) Object.assign(r.slot, { session: null, tokens: 0 });
      await save();
    } catch (e) {
      error = e.message;
    } finally {
      run = null;
    }
    if (r.stopped) {
      if (r.stopped !== 'button') error = r.stopped;
      return;
    }
    if (code === 0 && closed) return void setTimeout(() => start('next task'), NEXT_TASK_MS);
    // no progress: do not start again by itself, or a broken agent restarts forever
    error ||= code === 0 ? 'the agent closed no note' : `exit ${code}`;
    say('error: ' + error);
  }

  function kill() {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true });
    else try { process.kill(-run.child.pid, 'SIGKILL'); } catch { }
  }
  function stop(why) {
    if (why === 'button') auto = false;
    if (!run) return;
    run.stopped = why;
    kill();
    say(`stop: ${why}`);
  }
  setInterval(() => { if (run && !run.stopped && Date.now() - run.last > HUNG_MS) stop('hung: no output for 15 min'); }, 30_000).unref();

  async function status() {
    // read first, then look at the run: a task can end during the read
    const replies = await store.replies();
    const r = run;
    const state = r ? (r.stopped ? 'stopping' : 'working') : !auto ? 'stopped' : error ? 'error' : 'idle';
    let text;
    if (state === 'working') {
      const wip = Object.entries(replies).filter(([, x]) => x.status === 'wip' && x.session === r.session);
      text = `${MODELS[r.model]} ${r.name} works on ${ids(wip) || 'a task'} · ${kTokens(r.slot.tokens)} · since ${clock(r.started).slice(0, 5)}`;
    } else if (state === 'stopping') text = `${r.name} stops…`;
    else if (state === 'stopped') text = 'Stopped. New notes wait for Start.';
    else if (state === 'error') text = `Error: ${error}. Press Start to try again.`;
    else text = 'Idle · ' + Object.entries(MODELS)
      .map(([m, letter]) => `${letter} ${saved.by[m]?.session ? `${name(saved.by[m].session)}, ${kTokens(saved.by[m].tokens)}` : 'no session'}`).join(' · ');
    return { state, text, action: auto && !error ? 'stop' : 'start', log: log.slice(-40) };
  }

  return {
    // no agent runs when the server starts, so each `wip` note is left from an earlier run
    init: () => release(null, 'the server restarted', false),
    kick: why => start(why),
    start: () => { auto = true; error = ''; return start('button'); },
    stop: () => stop('button'),
    // the server stops: the notes of the agent go back to the queue on the next start
    shutdown: () => { if (run) { run.stopped = 'server stopped'; kill(); } },
    status,
    name,
  };
}
