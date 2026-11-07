// The review data, all in one folder:
// - notes.jsonl: the notes, one JSON object per line. Only the server writes this file.
// - replies.json: {id: {status, reply, session, started, tries, cost, ms, sessions, accepted}}. The review agent and the server write it.
//   A note with no entry is open. `accepted`: the time when the reviewer accepted the result of a closed note.
// - last-id: the number of the last note, so that the id of a deleted note is not used again.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CLOSED = new Set(['fixed', 'no']);

export async function createStore(dir) {
  await mkdir(dir, { recursive: true });
  const NOTES = join(dir, 'notes.jsonl'), REPLIES = join(dir, 'replies.json'), LAST_ID = join(dir, 'last-id');
  // the text of a file, or null when there is no file
  const text = f => readFile(f, 'utf8').catch(e => (e.code === 'ENOENT' ? null : Promise.reject(e)));

  // The agent can write replies.json while the server reads it: for a moment the file is empty or cut.
  // A read for the panel gives the last full read. A read before a write waits for a full file, so the write loses nothing.
  let last = {};
  async function readReplies(wait) {
    for (let tries = 0; ; tries++) {
      const s = await text(REPLIES);
      if (s === null) return (last = {});
      try { return (last = JSON.parse(s)); }
      catch {
        if (!wait) return last;
        if (tries === 20) throw new Error(`${REPLIES} is not valid JSON`);
      }
      await new Promise(ok => setTimeout(ok, 100));
    }
  }
  async function writeReplies(all) {
    await writeFile(REPLIES, JSON.stringify(all, null, 2));
    last = all;
  }
  async function readNotes() {
    const s = await text(NOTES);
    return s ? s.split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  }

  // the writes go one after another, so that a delete does not lose a note that comes at the same time
  let queue = Promise.resolve();
  const serial = f => (queue = queue.then(f, f));

  // the notes with their replies, the oldest first
  async function notes() {
    const [list, replies] = await Promise.all([readNotes(), readReplies(false)]);
    return list.map(n => ({ ...n, status: 'open', ...replies[n.id] }));
  }

  return {
    notes,
    replies: () => readReplies(false),
    // f changes the replies in place; its result is the result of the update
    updateReplies: f => serial(async () => {
      const all = await readReplies(true);
      const result = await f(all);
      await writeReplies(all);
      return result;
    }),
    // a new note gets the next id: above the last id and above each id in the notes
    add: fields => serial(async () => {
      const ids = (await readNotes()).map(n => +n.id.slice(1) || 0);
      const id = Math.max(+(await text(LAST_ID)) || 0, ...ids) + 1;
      const note = { id: 'n' + id, time: new Date().toISOString(), ...fields };
      await appendFile(NOTES, JSON.stringify(note) + '\n');
      await writeFile(LAST_ID, String(id));
      return note;
    }),
    // The server gives the notes `ids` to a task: the notes that still exist and are open become `wip` with `fields`
    // (the session and the start time of the task). Gives the ids of these notes.
    take: (ids, fields) => serial(async () => {
      const exist = new Set((await readNotes()).map(n => n.id));
      const all = await readReplies(true);
      const taken = ids.filter(id => exist.has(id) && (all[id]?.status ?? 'open') === 'open');
      for (const id of taken) all[id] = { ...all[id], status: 'wip', ...fields };
      if (taken.length) await writeReplies(all);
      return taken;
    }),
    // The reviewer accepts the result of a closed note (on: true), or takes the acceptance back. The status stays.
    accept: (id, on) => serial(async () => {
      const all = await readReplies(true);
      if (!(await readNotes()).some(n => n.id === id)) return { error: 'no such note' };
      if (!CLOSED.has(all[id]?.status)) return { error: 'the note is not closed' };
      if (on) all[id].accepted = new Date().toISOString();
      else delete all[id].accepted;
      await writeReplies(all);
      return { id, accepted: all[id].accepted ?? null };
    }),
    // a note in work stays: the agent works on it
    remove: id => serial(async () => {
      const note = (await notes()).find(n => n.id === id);
      if (!note) return { error: 'no such note' };
      if (note.status === 'wip') return { error: 'the agent works on this note' };
      const keep = (await readNotes()).filter(n => n.id !== id);
      await writeFile(NOTES, keep.map(n => JSON.stringify(n) + '\n').join(''));
      const all = await readReplies(true);
      if (id in all) { delete all[id]; await writeReplies(all); }
      return { deleted: id };
    }),
  };
}
