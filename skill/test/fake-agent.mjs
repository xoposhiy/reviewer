// A fake `claude -p` for the tests. It reads the task from stdin, works on the oldest open note as agent.md says,
// and prints the events of `--output-format stream-json`.
// FAKE_AGENT: `fix` (the default) marks the note `wip`, then `fixed`; `hang` marks it `wip` and waits until the server kills it;
// `idle` changes nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const task = readFileSync(0, 'utf8');
const field = re => task.match(re)[1];
const notesFile = field(/Notes: `([^`]+)`/), repliesFile = field(/Replies: `([^`]+)`/);
const session = field(/Your session: (\S+)\./), started = field(/Start time: (\S+)\./);
const mode = process.env.FAKE_AGENT || 'fix';
const print = e => console.log(JSON.stringify(e));

const replies = existsSync(repliesFile) ? JSON.parse(readFileSync(repliesFile, 'utf8')) : {};
const mark = (id, fields) => {
  replies[id] = { ...replies[id], ...fields };
  writeFileSync(repliesFile, JSON.stringify(replies, null, 2));
};

print({ type: 'assistant', message: { usage: { input_tokens: 1000, cache_read_input_tokens: 2000 }, content: [{ type: 'text', text: `mode ${mode}` }] } });
if (mode !== 'idle') {
  const note = readFileSync(notesFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .find(n => !replies[n.id] || replies[n.id].status === 'open');
  mark(note.id, { status: 'wip', session, started });
  if (mode === 'hang') setInterval(() => {}, 1000);
  else mark(note.id, { status: 'fixed', reply: 'done' });
}
if (mode !== 'hang') print({ type: 'result', total_cost_usd: 0.5, duration_ms: 3000, is_error: false });
