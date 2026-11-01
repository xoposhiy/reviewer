// Review panel. The review server adds this script to each HTML page that it serves.
// The ✎ button: open the panel; Esc: close it. Alt+click on the page: attach the element under the cursor to the note.
// Text selected on the page goes with the note as a quote.
// Ctrl+Enter or "Ω Send": send the note to the first model (Opus); Ctrl+Shift+Enter or "Σ Send": to the second model (Sonnet).
// PAGES.md says what a page does for the panel: it tells its place (window.reviewState) and opens a place from the hash.
// The panel lives in a shadow root, so the styles of the page and of the panel do not mix,
// and the keys and clicks in the panel do not go to the page.
// data-dock (the Markdown view): the panel stays open at the right side. When the page file changes, the panel sends
// a cancelable `review:changed` event: a page that shows the new file itself cancels it, and the panel shows no banner.
// A `review:refresh` event from the page makes the panel ask for the notes at once.
(() => {
  const { page: PAGE, models, dock } = document.currentScript.dataset;
  const DOCK = dock !== undefined;
  const MODELS = JSON.parse(models), [FIRST, SECOND] = Object.keys(MODELS);
  const POLL_MS = 4000, GO_MS = 300, DOCK_PX = 400;
  // the table of contents of the folder of the page
  const CONTENTS = '/' + PAGE.split('/').slice(0, -1).map(encodeURIComponent).map(p => p + '/').join('');
  const STATUS = { open: 'open', wip: 'in work', fixed: 'fixed', no: 'not fixed', stuck: 'stuck' };
  const CLOSED = new Set(['fixed', 'no']);
  const PICKER = {
    'too-big': 'Picker: Alt+click cannot pick a smaller part here. Fix the page markup (PAGES.md, "Elements"), so that Alt+click picks the part under the cursor.',
    wrong: 'Picker: Alt+click picks the wrong element here. Fix the page markup (PAGES.md, "Elements"), so that Alt+click picks the element under the cursor.',
  };

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const bare = h => String(h ?? '').replace(/^#/, '');
  const hashNow = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return location.hash.slice(1); } };
  async function api(path, init) {
    const r = await fetch('/__review/' + path, init);
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });

  // ---- The place of the reader (PAGES.md, "Place") ----

  const dynamic = () => typeof window.reviewState === 'function';
  // {where, hash}: from window.reviewState() of the page; on a page without it, from the last heading at the top of the window
  function place() {
    if (dynamic()) {
      try { const s = window.reviewState() || {}; return { where: squash(s.where), hash: bare(s.hash) }; }
      catch { return { where: '', hash: '' }; }
    }
    let heading = null;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!h.getClientRects().length) continue;  // hidden
      if (h.getBoundingClientRect().top > innerHeight / 4) break;
      heading = h;
    }
    if (!heading) return { where: '', hash: '' };
    return { where: squash(heading.textContent).slice(0, 100), hash: heading.id || heading.closest('section[id], article[id]')?.id || '' };
  }
  const where = p => p.where || (p.hash ? '#' + p.hash : 'top of the page');

  // "open here". A page without reviewState(): scroll to the element with this id.
  // A page with it opens the place on `hashchange` (a synthetic one when the hash is the same). When the page is not at the place
  // after GO_MS, the panel reloads it, and the page opens the place from the hash on load.
  function goTo(hash) {
    if (place().hash === hash) return;
    if (!dynamic()) {
      document.getElementById(hash)?.scrollIntoView();
      return history.replaceState(null, '', '#' + hash);
    }
    if (hashNow() === hash) dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: location.href }));
    else location.hash = hash;
    setTimeout(() => { if (place().hash !== hash) location.reload(); }, GO_MS);
  }

  // ---- The element under the cursor (PAGES.md, "Elements") ----

  // the click target; in SVG, the nearest <text>, <g> or [data-review] of the same SVG around the shape
  function partOf(t) {
    const svg = t.ownerSVGElement;
    if (!svg) return t;
    const part = t.closest('[data-review], text, g');
    return part && svg.contains(part) ? part : t;
  }
  // one element of a path: tag#id[name].class1.class2.class3, where name is the data-review attribute
  function label(n) {
    const classes = (n.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3);
    return n.localName + (n.id ? '#' + n.id : '') + (n.dataset?.review ? `[${n.dataset.review}]` : '') + classes.map(c => '.' + c).join('');
  }
  function pathOf(t) {
    const path = [];
    for (let n = t; n && n !== document.body && path.length < 4; n = n.parentElement) path.unshift(label(n));
    return path.join(' > ');
  }
  function describe(t, e) {
    const stack = document.elementsFromPoint(e.clientX, e.clientY)
      .filter(n => n !== host && n !== document.body && n !== document.documentElement).slice(0, 8).map(label);
    const text = squash(t.textContent) || t.getAttribute('alt') || t.getAttribute('aria-label') || '';
    return { text: text.slice(0, 160), path: pathOf(t), point: { x: Math.round(e.clientX), y: Math.round(e.clientY) }, stack };
  }

  // ---- The panel ----

  const host = document.createElement('review-panel');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: 600 12px system-ui, sans-serif; cursor: pointer; }
    a { color: #9fb6ff; cursor: pointer; }
    .open-button { position: fixed; left: 14px; bottom: 14px; z-index: 2147483000; padding: 8px 13px; border-radius: 99px; border: 1px solid #ffd166;
      background: #1c1606; color: #ffd166; font: 600 14px system-ui, sans-serif; box-shadow: 0 8px 24px -8px #000; }
    .open-button i { font-style: normal; margin-left: 6px; padding: 0 7px; border-radius: 99px; background: #ffd166; color: #1c1606; }
    .panel { position: fixed; left: 14px; bottom: 60px; z-index: 2147483000; width: 400px; max-width: calc(100vw - 28px); max-height: calc(100vh - 90px);
      display: flex; flex-direction: column; background: #141821; color: #e8ecf3; border: 1px solid #ffd166; border-radius: 14px;
      box-shadow: 0 20px 50px -14px #000; font: 14px/1.45 system-ui, sans-serif; }
    .panel.dock { left: auto; right: 0; top: 0; bottom: 0; width: ${DOCK_PX}px; max-width: none; max-height: none; border-width: 0 0 0 1px;
      border-radius: 0; box-shadow: none; }
    [hidden] { display: none !important; }
    .panel > :not(ol) { flex: none; }
    .where { padding: 10px 14px 0; font-size: 12px; color: #9aa4b8; }
    .where b { color: #ffd166; }
    .where { display: flex; gap: 6px; }
    .where span { margin-right: auto; min-width: 0; }
    .where a { white-space: nowrap; text-decoration: none; }
    .spent { padding: 2px 14px 0; font-size: 12px; color: #6f7a90; }
    .agent { display: flex; align-items: center; gap: 8px; padding: 6px 14px 0; font-size: 12px; color: #9aa4b8; }
    .agent span { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent span::before { content: '● '; color: var(--state); }
    .agent button, .attached button { border: 1px solid #333c4f; border-radius: 7px; padding: 2px 9px; background: none; color: #e8ecf3; }
    textarea { margin: 8px 14px 0; height: 130px; min-height: 80px; resize: vertical; background: #0b0e14; color: #e8ecf3; border: 1px solid #333c4f;
      border-radius: 9px; padding: 8px 10px; font: 14px/1.4 system-ui, sans-serif; }
    textarea:focus { outline: 1px solid #ffd166; }
    .attached, .quote { margin: 6px 14px 0; font: 12px ui-monospace, monospace; color: #9aa4b8; }
    .attached .text, .quote .text { color: #e8ecf3; }
    .quote .text { font: italic 13px system-ui, sans-serif; }
    .attached .remove, .quote .remove { border: 0; padding: 0 4px; color: #9aa4b8; }
    .attached .picker { display: flex; gap: 6px; margin-top: 4px; }
    .send { display: flex; align-items: center; gap: 8px; padding: 8px 14px 10px; border-bottom: 1px solid #262d3b; }
    .send span { font-size: 12px; color: #6f7a90; margin-right: auto; }
    .send span.error { color: #ffb3a8; }
    .send button { border: 0; border-radius: 8px; padding: 6px 12px; background: #ffd166; color: #1c1606; font: 700 14px system-ui, sans-serif; white-space: nowrap; }
    .send button + button { background: #9fb6ff; color: #0b1430; }
    ol { flex: 1 1 auto; min-height: 0; list-style: none; margin: 0; padding: 6px 14px 12px; overflow: auto; display: grid; align-content: start; gap: 8px; }
    li { padding: 7px 10px; border-radius: 9px; background: #1b2130; }
    li .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    li .model { font-weight: 700; color: #9aa4b8; margin-right: 6px; }
    li .status { font: 700 10.5px ui-monospace, monospace; padding: 1px 6px; border-radius: 99px; margin-right: 6px; background: #333c4f; color: #c9d1e0; }
    li .status.fixed { background: #1f5a48; color: #8ff0c9; }
    li .status.wip { background: #5a4a1f; color: #ffd166; }
    li .status.no, li .status.stuck { background: #4a2a2a; color: #ffb3a8; }
    li .meta { font-size: 11.5px; color: #6f7a90; }
    li .meta a { font-size: 12px; }
    li .meta a.delete { color: #ffb3a8; }
    li .quoted { margin: 2px 0 0; font: italic 12.5px system-ui, sans-serif; color: #9aa4b8; overflow-wrap: anywhere; }
    li .reply { margin-top: 4px; color: #8ff0c9; font-size: 13px; white-space: pre-wrap; }
    li .edit { margin-top: 4px; font-size: 12px; }
    li .edit summary { cursor: pointer; color: #ffd166; }
    li .edit pre { margin: 4px 0 0; padding: 4px 6px; border-radius: 6px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap;
      overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
    li .edit .before { background: #3a2226; color: #ffb3a8; }
    li .edit .after { background: #1d3a30; color: #8ff0c9; }
    .updated { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); z-index: 2147483001; padding: 8px 14px; border-radius: 10px;
      background: #ffd166; color: #1c1606; font: 600 14px system-ui, sans-serif; box-shadow: 0 10px 30px -10px #000; }
    .updated button { margin-left: 10px; border: 0; border-radius: 7px; padding: 4px 10px; background: #1c1606; color: #ffd166; font-size: 13px; }
  </style>
  <button class="open-button" title="Review notes">✎ Note<i hidden></i></button>
  <div class="panel${DOCK ? ' dock' : ''}" hidden>
    <div class="where"><b>Review</b> · <span></span><a href="${esc(CONTENTS)}" title="The table of contents of this folder">☰ Contents</a></div>
    <div class="spent" hidden></div>
    <div class="agent"><span></span><button></button></div>
    <textarea placeholder="What is wrong here? Select text on the page to quote it, Alt+click to attach an element."></textarea>
    <div class="quote" hidden></div>
    <div class="attached" hidden></div>
    <div class="send"><span></span>${Object.entries(MODELS).map(([m, letter]) =>
      `<button data-model="${esc(m)}" title="Send: a ${esc(m)} agent fixes the note">${esc(letter)} Send</button>`).join('')}</div>
    <ol></ol>
  </div>
  <div class="updated" hidden>The page was updated<button>Reload here</button></div>`;
  const $ = s => root.querySelector(s);
  const openButton = $('.open-button'), panel = $('.panel'), draft = $('textarea'), attached = $('.attached'), quote = $('.quote'), list = $('ol'), hint = $('.send span');
  const HINT = `Ctrl+Enter: ${MODELS[FIRST]}${SECOND ? ` · +Shift: ${MODELS[SECOND]}` : ''}${DOCK ? '' : ' · Esc: close'}`;
  hint.textContent = HINT;
  document.head.insertAdjacentHTML('beforeend', '<style>[data-review-picked] { outline: 2px solid #ffd166 !important; outline-offset: 2px !important; }' +
    (DOCK ? `html { margin-right: ${DOCK_PX}px; }` : '') + '</style>');
  document.body.append(host);
  openButton.hidden = DOCK;

  // the keys, clicks and wheel turns in the panel do not go to the page: a deck must not turn a slide when one types a note
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu'])
    host.addEventListener(type, e => e.stopPropagation(), { passive: true });

  // the draft stays when the page reloads
  const DRAFT = 'review-draft:' + PAGE;
  try { draft.value = sessionStorage.getItem(DRAFT) || ''; } catch { }
  const keepDraft = () => { try { sessionStorage.setItem(DRAFT, draft.value); } catch { } };
  draft.addEventListener('input', keepDraft);

  // a docked panel does not close: "close" only takes the focus from the draft
  let isOpen = DOCK;
  const showPlace = () => { $('.where span').textContent = where(place()); };
  function show(open) {
    if (DOCK && !open) return draft.blur();
    isOpen = open;
    panel.hidden = !open;
    if (!open) return;
    showPlace();
    draft.focus();
    refresh();
  }
  openButton.onclick = () => show(!isOpen);
  panel.hidden = !DOCK;
  if (DOCK) addEventListener('scroll', showPlace, { passive: true });

  addEventListener('keydown', e => {
    if (!e.composedPath().includes(host)) return;
    if (e.key === 'Escape') show(false);
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(e.shiftKey && SECOND ? SECOND : FIRST); }
  }, true);

  // ---- Attach an element ----

  let picked = null, pickedNode = null;
  function unpick() {
    picked = null;
    pickedNode?.removeAttribute('data-review-picked');
    pickedNode = null;
    attached.hidden = true;
  }
  // Alt+click attaches an element; a plain click outside the panel closes the panel, and the draft stays
  addEventListener('click', e => {
    if (e.composedPath().includes(host)) return;
    if (!e.altKey) {
      if (getSelection().isCollapsed) unselect();  // a plain click that selects nothing
      if (isOpen) show(false);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    const target = e.composedPath()[0];
    const t = partOf(target instanceof Element ? target : target.parentElement);
    unpick();
    picked = describe(t, e);
    pickedNode = t;
    t.setAttribute('data-review-picked', '');
    attached.innerHTML = `📎 <span class="text">${esc(picked.text || picked.path)}</span> <button class="remove" title="Remove">✕</button>` +
      `<div class="picker"><button data-issue="too-big">Can't pick a smaller part</button><button data-issue="wrong">Picks the wrong part</button></div>`;
    attached.hidden = false;
    show(true);
  }, true);
  attached.onclick = e => {
    const b = e.target.closest('button');
    if (b?.classList.contains('remove')) unpick();
    else if (b?.dataset.issue) send(FIRST, b.dataset.issue);
  };

  // ---- Quote the selected text ----

  // A click in the panel clears the selection on the page, so the panel keeps the last text that the reader selected.
  // A new selection replaces it; a plain click on the page that selects nothing, ✕ and "Send" remove it.
  const QUOTE_MAX = 2000;
  let selected = null;
  function unselect() {
    selected = null;
    quote.hidden = true;
  }
  document.addEventListener('selectionchange', () => {
    // a selection in the draft, or in a field of the page (the block editor of the Markdown view)
    if (document.activeElement === host || document.activeElement?.matches('input, textarea, [contenteditable]')) return;
    const s = getSelection(), text = squash(s.toString());
    if (!text || !s.rangeCount) return;
    const common = s.getRangeAt(0).commonAncestorContainer;
    const t = common instanceof Element ? common : common.parentElement;
    if (!t || t === host) return;
    selected = { text: text.slice(0, QUOTE_MAX), path: pathOf(t) };
    const shown = selected.text.length > 200 ? selected.text.slice(0, 200) + '…' : selected.text;
    quote.innerHTML = `❝ <span class="text">${esc(shown)}</span> <button class="remove" title="Do not quote it">✕</button>`;
    quote.hidden = false;
  });
  quote.onclick = e => { if (e.target.closest('button')) unselect(); };

  // ---- Send a note ----

  // issue: a picker button; its task goes before the draft
  async function send(model, issue) {
    const text = [issue && PICKER[issue], draft.value.trim()].filter(Boolean).join('\n');
    if (!text) return;
    const p = place();
    const el = picked && (issue ? { ...picked, issue } : picked);
    try {
      await post('notes', { page: PAGE, text, model, el, sel: selected, ctx: { where: where(p), hash: p.hash, w: innerWidth, h: innerHeight } });
    } catch (e) {
      hint.textContent = 'Not sent: ' + e.message;
      hint.className = 'error';
      return;
    }
    hint.textContent = HINT; hint.className = '';
    draft.value = ''; keepDraft();
    unpick();
    unselect();
    show(false);
    refresh();
  }
  root.querySelectorAll('[data-model]').forEach(b => b.onclick = () => send(b.dataset.model));

  // ---- The notes, the agent and the page updates ----

  // the cost (USD) and the time that the agents spent: "$0.42", "40 s", "12 min", "1 h 5 min"
  const usd = x => '$' + (x < 10 ? x.toFixed(2) : x.toFixed(0));
  const duration = ms => {
    const s = Math.round(ms / 1000), m = Math.round(s / 60);
    return s < 60 ? s + ' s' : m < 60 ? m + ' min' : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const spent = n => [n.cost && usd(n.cost), n.ms && duration(n.ms)].filter(Boolean).join(' · ');

  function showSpent(notes) {
    const box = $('.spent');
    const sessions = new Set(notes.flatMap(n => n.sessions || [])).size;
    box.hidden = !sessions;
    const cost = notes.reduce((a, n) => a + (n.cost || 0), 0), ms = notes.reduce((a, n) => a + (n.ms || 0), 0);
    box.textContent = `This page: ${usd(cost)} · ${sessions} agent session${sessions === 1 ? '' : 's'} · ${duration(ms)} of agent work`;
  }

  const STATE_COLOR = { working: '#8ff0c9', stopping: '#ffd166', idle: '#6f7a90', stopped: '#ffb3a8', error: '#ffb3a8' };
  function showAgent(a) {
    const box = $('.agent'), text = box.querySelector('span'), button = box.querySelector('button');
    box.style.setProperty('--state', STATE_COLOR[a.state]);
    // one line, so that a long text does not move the list; the full text is in the tooltip
    text.textContent = 'Agent: ' + a.text;
    text.title = a.text;
    button.textContent = a.action === 'stop' ? 'Stop' : 'Start';
    button.onclick = () => post('agent/' + a.action).then(showAgent).catch(() => {});
  }

  // an edit in the Markdown view: the text before and after; the text of the note is optional
  const edit = e => `<details class="edit"><summary>✎ Edit at line ${esc(e.line)}</summary>` +
    `<pre class="before">${esc(e.before)}</pre><pre class="after">${esc(e.after) || '(removed)'}</pre></details>`;
  function item(n) {
    const status = `<span class="status ${esc(n.status)}">${esc(STATUS[n.status] || n.status)}${n.agent && n.status !== 'open' ? ' · ' + esc(n.agent) : ''}</span>`;
    const model = MODELS[n.model] ? `<span class="model" title="${esc(n.model)}">${esc(MODELS[n.model])}</span>` : '';
    const meta = [esc(n.id), esc(n.ctx?.where), n.ctx?.hash && `<a data-go="${esc(bare(n.ctx.hash))}">open here</a>`, esc(spent(n)),
      n.status !== 'wip' && `<a class="delete" data-delete="${esc(n.id)}">delete</a>`].filter(Boolean).join(' · ');
    const quoted = n.sel?.text ? `<div class="quoted">❝ ${esc(n.sel.text.length > 200 ? n.sel.text.slice(0, 200) + '…' : n.sel.text)}</div>` : '';
    return `<li data-id="${esc(n.id)}"><div class="text">${model}${status}${esc(n.text)}</div>${quoted}${n.edit ? edit(n.edit) : ''}<div class="meta">${meta}</div>` +
      (n.reply ? `<div class="reply">${esc(n.reply)}</div>` : '') + '</li>';
  }

  // The list is drawn again only when it changed, so that a scroll, a selection or a hover stays.
  // After a change, the note at the top of the view stays in its place.
  let drawn = '';
  function showNotes(notes) {
    const html = notes.slice().reverse().map(item).join('');
    if (html === drawn) return;
    drawn = html;
    const top = list.getBoundingClientRect().top;
    const anchor = list.scrollTop > 0 ? [...list.children].find(li => li.getBoundingClientRect().bottom > top) : null;
    const offset = anchor && anchor.getBoundingClientRect().top - top;
    list.innerHTML = html;
    const same = anchor && [...list.children].find(li => li.dataset.id === anchor.dataset.id);
    if (same) list.scrollTop += same.getBoundingClientRect().top - top - offset;
  }
  list.onclick = async e => {
    const a = e.target.closest('a');
    if (a?.dataset.go) goTo(a.dataset.go);
    if (!a?.dataset.delete || !confirm(`Delete note ${a.dataset.delete}?`)) return;
    try { await api('notes?id=' + encodeURIComponent(a.dataset.delete), { method: 'DELETE' }); }
    catch (err) { alert(`Not deleted: ${err.message}.`); }
    refresh();
  };

  // the page file changed: offer a reload at the same place, unless the page shows the new file itself
  let seen = 0;
  function watch(mtime) {
    if (!seen) seen = mtime;
    if (!mtime || mtime === seen) return;
    if (dispatchEvent(new CustomEvent('review:changed', { cancelable: true }))) $('.updated').hidden = false;
    else seen = mtime;
  }
  $('.updated button').onclick = () => {
    const { hash } = place();
    if (hash) history.replaceState(null, '', '#' + hash);
    location.reload();
  };

  // one request gives the notes of the page, the time of its file and the agent status; an error keeps the old view
  async function refresh() {
    let r;
    try { r = await api('page?path=' + encodeURIComponent(PAGE)); } catch { return; }
    const left = r.notes.filter(n => !CLOSED.has(n.status)).length;
    const badge = openButton.querySelector('i');
    badge.hidden = !left;
    badge.textContent = left;
    watch(r.mtime);
    if (!isOpen) return;
    if (DOCK) showPlace();  // the Markdown view renders the headings after the panel starts
    showAgent(r.agent);
    showSpent(r.notes);
    showNotes(r.notes);
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  addEventListener('review:refresh', refresh);
})();
