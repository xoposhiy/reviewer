// The log of an agent session: what the agent did, step by step, how long each step took, and what the session spent. No I/O here.
// agent.mjs turns each event of `claude -p --output-format stream-json` into records (recordsOf) and appends them
// to <data>/sessions/<session>.jsonl, with its own records of the start (`task`) and the end (`end`) of each task.
// The session page shows the view of the records (viewOf).
//
// The records, each with `t`, the time when the server got it (ms):
// - task: a task starts: `ids` (its notes), `model`, `why`, `resume` (the task resumes the session)
// - init: the model id that the agent reports
// - think, say: a thinking block, a text block of the model
// - tool: a tool call: `id`, `name`, `brief` (one line), `input` (JSON)
// - done: the result of a tool call: `id`, `text`, `error`
// - result: the task ended for the agent: `cost` (USD), `ms`, `turns`, `error`
// - end: the server saw the end of the task: `why`, `closed` (the count of the notes that the task closed)
// think, say and tool have `msg`, the id of their model message. The first record of each message event has `usage`.
import { isAbsolute, relative } from 'node:path';

const TEXT_MAX = 20_000, TOOL_MAX = 4000, BRIEF_MAX = 160;
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

// one line for a tool call: the file (from the root), the command, the pattern, ...
function briefOf(input = {}, root) {
  const file = input.file_path || input.notebook_path || input.path;
  const shown = file && root && isAbsolute(file) && !relative(root, file).startsWith('..') ? relative(root, file).replaceAll('\\', '/') : file;
  const arg = input.command || input.pattern || input.url || input.query || input.skill || input.prompt || input.description || '';
  const line = oneLine([shown, arg].filter(Boolean).join(' · '));
  return line.length > BRIEF_MAX ? line.slice(0, BRIEF_MAX) + '…' : line;
}

const usageOf = u => u && {
  in: u.input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
  out: u.output_tokens || 0, thinking: u.output_tokens_details?.thinking_tokens || 0,
};
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : '');

// The records of one event. t: the time of the event; root: the project folder, for the paths in the tool calls.
export function recordsOf(e, { t, root }) {
  if (e.type === 'system' && e.subtype === 'init') return [{ t, kind: 'init', model: e.model }];
  if (e.type === 'result') {
    return [{ t, kind: 'result', cost: e.total_cost_usd, ms: e.duration_ms, turns: e.num_turns,
      error: e.is_error ? cut(String(e.result || e.subtype), TOOL_MAX) : undefined }];
  }
  if (e.type === 'assistant') {
    const msg = e.message?.id, out = [];
    for (const c of e.message?.content || []) {
      if (c.type === 'thinking') out.push({ t, kind: 'think', msg, text: cut(c.thinking || '', TEXT_MAX) });
      if (c.type === 'redacted_thinking') out.push({ t, kind: 'think', msg, text: '' });
      if (c.type === 'text' && c.text.trim()) out.push({ t, kind: 'say', msg, text: cut(c.text.trim(), TEXT_MAX) });
      if (c.type === 'tool_use') {
        out.push({ t, kind: 'tool', msg, id: c.id, name: c.name, brief: briefOf(c.input, root), input: cut(JSON.stringify(c.input ?? {}, null, 2), TOOL_MAX) });
      }
    }
    if (out.length) out[0].usage = usageOf(e.message.usage);
    return out;
  }
  if (e.type === 'user') {
    return (Array.isArray(e.message?.content) ? e.message.content : []).filter(c => c.type === 'tool_result')
      .map(c => ({ t, kind: 'done', id: c.tool_use_id, text: cut(textOf(c.content), TOOL_MAX), error: !!c.is_error }));
  }
  return [];
}

const ZERO = () => ({ in: 0, cacheRead: 0, cacheWrite: 0, out: 0, thinking: 0 });
const add = (sum, u) => { for (const k of Object.keys(sum)) sum[k] += u[k] || 0; };

// The view of the records of a session: its tasks with their steps, the totals, and what the agent does now.
// live: an agent runs the session now; now: the current time (ms).
// A step is a block of the model (think, say) or a tool call. `wait`: the time from the record before the step
// to the step: the time that the model took for it. `run`: the time of a tool call, to its result.
// A running tool call has no `run`; a tool call that never got its result has `lost`.
export function viewOf(records, { live = false, now = Date.now() } = {}) {
  const tasks = [], usage = new Map(), tools = {};
  let model = null, task = null, prev = null;
  const byTool = new Map();
  const startTask = r => {
    task = { start: r.t, ids: r.ids || [], model: r.model || null, why: r.why || '', resume: !!r.resume, end: null, endWhy: null, closed: null,
      cost: null, ms: null, turns: null, error: null, steps: [], usage: ZERO(), modelMs: 0, toolMs: 0 };
    tasks.push(task);
    prev = r.t;
  };
  for (const r of records) {
    if (r.kind === 'task' || !task) startTask(r);
    if (r.kind === 'task') continue;
    if (r.kind === 'init') model = r.model;
    if (r.kind === 'result') Object.assign(task, { cost: r.cost ?? null, ms: r.ms ?? null, turns: r.turns ?? null, error: r.error || null });
    if (r.kind === 'end') Object.assign(task, { end: r.t, endWhy: r.why, closed: r.closed ?? null });
    if (r.kind === 'think' || r.kind === 'say' || r.kind === 'tool') {
      const step = { t: r.t, kind: r.kind, wait: Math.max(0, r.t - prev) };
      if (r.kind === 'tool') {
        Object.assign(step, { name: r.name, brief: r.brief, input: r.input, run: null, result: null, error: false });
        byTool.set(r.id, step);
        (tools[r.name] ||= { calls: 0, ms: 0 }).calls++;
      } else step.text = r.text;
      if (r.usage) {
        step.usage = r.usage;
        usage.set(r.msg ?? Symbol('message'), { task, usage: r.usage });
      }
      task.modelMs += step.wait;
      task.steps.push(step);
    }
    if (r.kind === 'done') {
      const step = byTool.get(r.id);
      if (step) {
        Object.assign(step, { run: Math.max(0, r.t - step.t), result: r.text, error: r.error });
        tools[step.name].ms += step.run;
      }
    }
    prev = r.t;
  }
  // the usage of a message: its last event has the final count
  const totals = ZERO();
  let context = 0;
  for (const { task: owner, usage: u } of usage.values()) {
    add(owner.usage, u);
    add(totals, u);
    context = u.in + u.cacheRead + u.cacheWrite;
  }
  const last = tasks.at(-1), running = live && last && last.end == null;
  for (const x of tasks) {
    const open = x === last && running;
    // a task with no end record and no agent: the server stopped during the task
    if (x.end == null && !open) Object.assign(x, { end: x.steps.at(-1)?.t ?? x.start, endWhy: 'unknown: the server stopped during the task' });
    for (const s of x.steps) if (s.kind === 'tool' && s.run == null) { if (open) continue; s.lost = true; }
    x.toolMs = x.steps.reduce((a, s) => a + (s.run || 0), 0);
  }
  // what the agent does now: a tool call that has no result yet, else the model works on its next step
  let doing = null;
  if (running) {
    const waits = last.steps.filter(s => s.kind === 'tool' && s.run == null);
    doing = waits.length ? { kind: 'tool', since: waits[0].t, names: waits.map(s => s.name), brief: waits[0].brief } : { kind: 'model', since: prev ?? last.start };
  }
  const sum = k => tasks.reduce((a, x) => a + (x[k] || 0), 0);
  return {
    model, tasks, doing,
    totals: { ...totals, context, cost: sum('cost'), ms: tasks.reduce((a, x) => a + ((x.end ?? now) - x.start), 0),
      modelMs: sum('modelMs'), toolMs: sum('toolMs'), turns: sum('turns'), steps: tasks.reduce((a, x) => a + x.steps.length, 0), tools },
  };
}

// The records of a session file. A line that is not JSON (the last line while it is written) is left out.
export const parseLog = text => text.split('\n').flatMap(l => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
