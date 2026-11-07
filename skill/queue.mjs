// The queue of the review agent: which open notes the next task takes, and with which model. No I/O here.
// - A task starts with the oldest open note of its model and takes up to MAX_NOTES - 1 more open notes at the same place
//   (the same page and the same place on it), the oldest first.
// - The strong model (the first one, Opus) also takes the notes of the other model at the place of its own note:
//   one task costs less and ends sooner than two tasks. The other model never takes the notes of the strong model.
// - A reply (a note with `re`) goes to the session that closed its note, and a note with `to` goes to that session,
//   while the session is the current session of its model. A note sent with a stronger model goes to that model instead.
// - Each model resumes its own session, so a switch of the model starts with a cold prompt cache. The model with a warm cache
//   keeps the turn while it has a note to start with, unless the oldest note of the other model is older by more than STAY_MS.
//   With no warm model, the oldest note chooses the model.
export const MAX_NOTES = 3, STAY_MS = 10 * 60_000;

// the page and the place on it: the hash of the place, or its name when the page gives no hash
export const placeOf = n => `${n.page}#${n.ctx?.hash || n.ctx?.where || ''}`;

// notes: all notes with their replies, the oldest first; models: the models, the strong one first;
// sessions: the current session of each model, {opus: id or null, ...}; warm: the model with a warm prompt cache, or null.
// Gives {model, notes} or null.
export function nextTask(notes, { models, sessions = {}, warm = null }) {
  const [strong] = models;
  const byId = new Map(notes.map(n => [n.id, n]));
  // bound: a note that must go to a session: a reply, or a note with `to`
  const open = notes.filter(n => n.status === 'open').map(n => {
    const s = n.to || (n.re && byId.get(n.re)?.session);
    // the model of the note wins only when it is stronger than the model of that session: the reviewer asks for a better agent
    const owner = s && models.find(m => sessions[m] === s && models.indexOf(m) <= models.indexOf(n.model));
    return { n, model: owner || (models.includes(n.model) ? n.model : strong), bound: !!owner };
  });
  const takes = (model, x) => x.model === model || (model === strong && !x.bound);
  // a note of the other model at the place of an open note of the strong model waits for the strong model
  const strongAt = new Set(open.filter(x => x.model === strong).map(x => placeOf(x.n)));
  const leads = open.filter(x => x.model === strong || x.bound || !strongAt.has(placeOf(x.n)));
  if (!leads.length) return null;
  const oldest = leads[0], mine = leads.find(x => x.model === warm);
  const stay = mine && Date.parse(mine.n.time) - Date.parse(oldest.n.time) <= STAY_MS;
  const first = stay ? mine : oldest, place = placeOf(first.n);
  const more = open.filter(x => x !== first && placeOf(x.n) === place && takes(first.model, x)).slice(0, MAX_NOTES - 1);
  return { model: first.model, notes: [first, ...more].map(x => x.n) };
}
