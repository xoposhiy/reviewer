// A fake `claude -p` for the tests. It reads the task from stdin and works on the notes that the task names, as agent.md says:
// the server marked them `wip` already. It prints the events of `--output-format stream-json`.
// FAKE_AGENT: `fix` (the default) marks the notes `fixed`; `hang` waits until the server kills it; `idle` changes nothing.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const task = readFileSync(0, 'utf8');
const field = re => task.match(re)[1];
const repliesFile = field(/Replies: `([^`]+)`/), ids = field(/Your notes: ([\w, ]+)\./).split(', ');
const mode = process.env.FAKE_AGENT || 'fix';
const print = e => console.log(JSON.stringify(e));

print({ type: 'system', subtype: 'init', model: 'fake-model-1' });
print({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 50 },
  content: [{ type: 'text', text: `mode ${mode}` }] } });
print({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 80 },
  content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: repliesFile } }] } });
print({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the replies' }] } });
if (mode === 'hang') setInterval(() => {}, 1000);
if (mode === 'fix') {
  const replies = existsSync(repliesFile) ? JSON.parse(readFileSync(repliesFile, 'utf8')) : {};
  for (const id of ids) replies[id] = { ...replies[id], status: 'fixed', reply: 'done' };
  writeFileSync(repliesFile, JSON.stringify(replies, null, 2));
}
if (mode !== 'hang') print({ type: 'result', total_cost_usd: 0.5, duration_ms: 3000, is_error: false });
