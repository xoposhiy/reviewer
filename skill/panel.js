// Review panel. The review server adds this script to each HTML page that it serves.
// The panel lies over the page at the right side, full height. The ✎ button at the bottom right: open the panel;
// Esc, ✕ or a click on the page: close it. Alt+click on the page: attach the element under the cursor to the note.
// Text selected on the page goes with the note as a quote.
// Ctrl+Enter or "Ω Send": send the note to the first model (Opus); Ctrl+Shift+Enter or "Σ Send": to the second model (Sonnet).
// PAGES.md says what a page does for the panel: it tells its place (window.reviewState) and opens a place from the hash.
// The panel lives in a shadow root, so the styles of the page and of the panel do not mix,
// and the keys and clicks in the panel do not go to the page. The panel follows the light or dark color scheme of the system.
// data-dock (the Markdown view): the panel stays open, and the page gets a margin for it. When the page file changes, the panel sends
// a cancelable `review:changed` event: a page that shows the new file itself cancels it, and the panel shows no banner.
// A `review:refresh` event from the page makes the panel ask for the notes at once.
// "open here" sends a cancelable `review:highlight` event with the note: a page that highlights the note itself cancels it.
(() => {
  const { page: PAGE, models, dock } = document.currentScript.dataset;
  const DOCK = dock !== undefined;
  const MODELS = JSON.parse(models), [FIRST, SECOND] = Object.keys(MODELS);
  const POLL_MS = 4000, GO_MS = 300, PANEL_PX = 400;
  // the table of contents of the folder of the page
  const CONTENTS = '/' + PAGE.split('/').slice(0, -1).map(encodeURIComponent).map(p => p + '/').join('');
  const STATUS = { open: 'open', wip: 'in work', fixed: 'fixed', no: 'not fixed', stuck: 'stuck' };
  const STATUS_HINT = {
    open: 'Open: the note waits for the agent',
    wip: 'In work: an agent works on this note now',
    fixed: 'Fixed: the agent changed the files. Its reply says what it changed',
    no: 'Not fixed: the agent changed nothing. Its reply says why',
    stuck: 'Stuck: agents stopped twice before the end of the work on this note, so the agents skip it now',
  };
  const CLOSED = new Set(['fixed', 'no']);
  // "opus" → "an Opus agent"
  const agentOf = m => `${/^[aeiou]/i.test(m) ? 'an' : 'a'} ${m[0].toUpperCase() + m.slice(1)} agent`;
  const SEND_KEYS = ['Ctrl+Enter', 'Ctrl+Shift+Enter'];
  const OPEN_HINT = 'Review notes', PLACEHOLDER = 'What is wrong here? Select text on the page to quote it, Alt+click to attach an element.';
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
  // At the place, the panel highlights what the note is about (mark()); after a reload too.
  function goTo(hash, note) {
    if (place().hash === hash) return mark(note);
    if (!dynamic()) {
      document.getElementById(hash)?.scrollIntoView();
      history.replaceState(null, '', '#' + hash);
      return mark(note);
    }
    if (hashNow() === hash) dispatchEvent(new HashChangeEvent('hashchange', { oldURL: location.href, newURL: location.href }));
    else location.hash = hash;
    setTimeout(() => {
      if (place().hash === hash) return mark(note);
      markAfterReload(note);
      location.reload();
    }, GO_MS);
  }

  // ---- What a note is about ----

  // "open here" highlights for a moment the quoted text of the note, else its attached element, and scrolls to it.
  // The page can do it itself: it cancels the `review:highlight` event (the Markdown view highlights the block of an edit).
  // Nothing found: the page stays at the place of the note.
  const MARK_MS = 2500, FADE_MS = 100, FADE = [0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
  function mark(note) {
    if (!note || !dispatchEvent(new CustomEvent('review:highlight', { cancelable: true, detail: note }))) return;
    if (note.sel?.text && markText(note.sel.text)) return;
    const n = note.el && findElement(note.el);
    if (n) { reveal(n.getBoundingClientRect(), n); flashElement(n); }
  }
  const MARK = 'review-mark:' + PAGE;
  function markAfterReload(note) { try { if (note) sessionStorage.setItem(MARK, JSON.stringify(note)); } catch { } }
  try {
    const note = JSON.parse(sessionStorage.getItem(MARK));
    sessionStorage.removeItem(MARK);
    if (note) addEventListener('load', () => setTimeout(() => mark(note), GO_MS));
  } catch { }

  const reveal = (rect, n) => { if (rect.top < 0 || rect.bottom > innerHeight) n.scrollIntoView({ block: 'center' }); };

  // The letters of the page with no whitespace, and the text node and the offset of each letter.
  // No whitespace, because the quote is squashed, and a selection puts line breaks between blocks that the text nodes do not have.
  function letters() {
    const out = { text: '', nodes: [], offsets: [] }, chars = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: t => (t.parentElement?.closest('script, style, noscript, template, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let t; (t = walker.nextNode());)
      for (const m of t.data.matchAll(/\S/g)) { chars.push(m[0]); out.nodes.push(t); out.offsets.push(m.index); }
    out.text = chars.join('');
    return out;
  }
  function markText(quote) {
    const q = quote.replace(/\s+/g, '');
    if (!q) return false;
    const { text, nodes, offsets } = letters();
    // the agent may have changed the text since the note: then its start or its end shows the place
    for (const part of new Set([q, q.slice(0, 40), q.slice(-40)])) {
      const found = [];
      for (let i = text.indexOf(part); i >= 0 && found.length < 50; i = text.indexOf(part, i + 1)) {
        const r = document.createRange(), end = i + part.length - 1;
        r.setStart(nodes[i], offsets[i]);
        r.setEnd(nodes[end], offsets[end] + 1);
        if (r.getClientRects().length) found.push(r);
      }
      if (!found.length) continue;
      // of several copies, the one nearest to the middle of the window: the page is at the place of the note now
      const off = r => Math.abs(r.getBoundingClientRect().top - innerHeight / 2);
      const best = found.reduce((a, b) => (off(b) < off(a) ? b : a));
      reveal(best.getBoundingClientRect(), best.startContainer.parentElement);
      flashRange(best);
      return true;
    }
    return false;
  }

  // a label of label() as CSS selectors: `full` with the classes, `bare` without them (a class like "active" can change)
  function selectorOf(l) {
    const m = l.match(/^([^#[.\s]+)(?:#([^[.]+))?(?:\[([^\]]*)\])?((?:\.[^.]+)*)$/);
    if (!m) return null;
    const [, tag, id, name, classes] = m;
    const bare = CSS.escape(tag) + (id ? '#' + CSS.escape(id) : '') + (name ? `[data-review="${CSS.escape(name)}"]` : '');
    return { tag: CSS.escape(tag), bare, full: bare + classes.split('.').filter(Boolean).map(c => '.' + CSS.escape(c)).join('') };
  }
  // the element of describe(): by its path and its text, by its path, then by its text only
  function findElement(el) {
    const all = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
    const textOf = n => (squash(n.textContent) || n.getAttribute('alt') || n.getAttribute('aria-label') || '').slice(0, 160);
    const sameText = n => textOf(n) === el.text;
    const labels = String(el.path || '').split(' > ').map(selectorOf);
    let byPath = [], loose = [], byText = [];
    if (labels.every(Boolean)) {
      // a short path starts at the body
      const chain = key => (labels.length < 4 ? 'body > ' : '') + labels.map(l => l[key]).join(' > ');
      byPath = all(chain('full'));
      loose = all(chain('bare'));
      if (el.text) byText = all(labels.at(-1).tag).filter(sameText);
    }
    const found = el.text ? [...byPath.filter(sameText), ...loose.filter(sameText), ...byPath, ...byText] : byPath;
    return found.find(n => n.getClientRects().length);
  }

  document.head.insertAdjacentHTML('beforeend', '<style>' + FADE.map((a, k) => `::highlight(review-mark-${k}) { background-color: rgba(255, 209, 102, ${a}); }`).join('') +
    '[data-review-mark] { outline: 2px solid #e3a008 !important; outline-offset: 2px !important; }' +
    `[data-review-mark=fade] { outline-color: transparent !important; transition: outline-color ${FADE_MS * FADE.length}ms; }</style>`);

  let unmark = () => {};
  // the CSS Custom Highlight API; a browser without it shows no highlight. It fades in steps: a highlight has no transition.
  function flashRange(range) {
    unmark();
    if (!window.CSS?.highlights) return;
    const h = new Highlight(range);
    let step = 0, timer;
    const name = () => 'review-mark-' + step;
    CSS.highlights.set(name(), h);
    timer = setTimeout(function fade() {
      CSS.highlights.delete(name());
      if (++step < FADE.length) { CSS.highlights.set(name(), h); timer = setTimeout(fade, FADE_MS); }
    }, MARK_MS);
    unmark = () => { clearTimeout(timer); CSS.highlights.delete(name()); };
  }
  function flashElement(n) {
    unmark();
    n.setAttribute('data-review-mark', '');
    const fade = setTimeout(() => n.setAttribute('data-review-mark', 'fade'), MARK_MS);
    const end = setTimeout(() => n.removeAttribute('data-review-mark'), MARK_MS + FADE_MS * FADE.length);
    unmark = () => { clearTimeout(fade); clearTimeout(end); n.removeAttribute('data-review-mark'); };
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
    :host { all: initial; color-scheme: light; --bg: #fff; --fg: #1f2328; --muted: #59636e; --faint: #818b98; --line: #d1d9e0;
      --accent: #0969da; --fill: #0969da; --on-fill: #fff; --tint: #0969da14; --ok: #1a7f37; --ok-bg: #1a7f3714; --bad: #cf222e; --bad-bg: #cf222e12; }
    @media (prefers-color-scheme: dark) {
      :host { color-scheme: dark; --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --faint: #6e7681; --line: #30363d;
        --accent: #4493f8; --fill: #1f6feb; --on-fill: #fff; --tint: #4493f81f; --ok: #3fb950; --ok-bg: #3fb9501a; --bad: #f85149; --bad-bg: #f851491a; }
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { border: 1px solid var(--line); border-radius: 0; padding: 3px 10px; background: none; color: var(--fg); font: 12px/1.4 system-ui, sans-serif; cursor: pointer; }
    button:hover { border-color: var(--muted); }
    a { color: var(--accent); cursor: pointer; text-decoration: none; }
    a:hover { text-decoration: underline; }
    button:focus-visible, a:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
    .open-button, .panel { position: fixed; z-index: 2147483000; }
    .open-button { right: 16px; bottom: 16px; padding: 7px 12px; background: var(--bg); font: 600 13px/1.4 system-ui, sans-serif; }
    .open-button:hover { border-color: var(--accent); }
    .open-button i { font-style: normal; margin-left: 8px; padding: 0 6px; background: var(--muted); color: var(--bg); }
    .open-button.due { border-color: var(--fill); animation: pulse 2s ease-in-out infinite; }
    .open-button.due i { background: var(--fill); color: var(--on-fill); }
    /* a square ring that grows and fades */
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--fill) 55%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
    @media (prefers-reduced-motion: reduce) { .open-button.due, .agent .fix { animation: none; } }
    .panel { right: 0; top: 0; bottom: 0; width: ${PANEL_PX}px; max-width: 100vw; display: flex; flex-direction: column;
      background: var(--bg); color: var(--fg); border-left: 1px solid var(--line); font: 14px/1.45 system-ui, sans-serif; }
    .panel > :not(ol) { flex: none; }
    .where { display: flex; align-items: baseline; gap: 6px; padding: 12px 16px 0; font-size: 12px; color: var(--muted); }
    .where b { color: var(--fg); font-weight: 600; }
    .where span { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .where a { white-space: nowrap; }
    .spent { padding: 2px 16px 0; font-size: 12px; color: var(--faint); }
    .agent { display: flex; align-items: center; gap: 8px; padding: 8px 16px 0; font-size: 12px; color: var(--muted); }
    .agent span { margin-right: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent span::before, li .status::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; vertical-align: 1px; background: currentColor; }
    .agent span::before { background: var(--state); }
    .agent .fix, .send button:first-of-type { border-color: var(--fill); background: var(--fill); color: var(--on-fill); font-weight: 600; }
    .agent .fix { white-space: nowrap; animation: pulse 2s ease-in-out infinite; }
    .send button + button { border-color: var(--accent); color: var(--accent); font-weight: 600; }
    .remove, .more, .close { border: 0; padding: 0 4px; color: var(--muted); }
    .remove:hover, .more:hover, .close:hover { color: var(--fg); }
    .replying { margin: 10px 16px 0; font-size: 12px; color: var(--accent); }
    .replying b { font-weight: 600; }
    .replying + textarea { margin-top: 4px; }
    textarea { display: block; width: calc(100% - 32px); margin: 10px 16px 0; height: 130px; min-height: 80px; resize: vertical; padding: 8px 10px;
      border: 1px solid var(--line); border-radius: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
    textarea::placeholder { color: var(--faint); }
    textarea:focus { outline: none; border-color: var(--accent); }
    .attached, .quote { margin: 6px 16px 0; font: 12px/1.45 ui-monospace, monospace; color: var(--muted); }
    .attached .text, .quote .text { color: var(--fg); }
    .quote .text { font: italic 13px/1.45 system-ui, sans-serif; }
    /* a quote from the attached element: under it, as a part of it */
    .attached:not([hidden]) + .quote { margin-left: 32px; }
    .attached .picker { display: flex; gap: 6px; margin-top: 6px; }
    .send { display: flex; align-items: center; gap: 8px; padding: 10px 16px 12px; border-bottom: 1px solid var(--line); }
    .send span { margin-right: auto; font-size: 12px; color: var(--faint); }
    .send span.error { color: var(--bad); }
    .send button { padding: 5px 12px; font-size: 13px; white-space: nowrap; }
    .panel > ol { flex: 1 1 auto; min-height: 0; overflow: auto; }
    ol { list-style: none; margin: 0; padding: 0; }
    li { padding: 10px 16px; border-bottom: 1px solid var(--line); }
    li.shown { background: var(--tint); }
    li .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    li .model { margin-right: 6px; font-weight: 600; color: var(--muted); }
    li .status { margin-right: 8px; font-size: 12px; font-weight: 600; color: var(--faint); white-space: nowrap; }
    li .status.wip { color: var(--accent); }
    li .status.fixed { color: var(--ok); }
    li .status.no, li .status.stuck { color: var(--bad); }
    li .re { margin-right: 6px; font-size: 12px; }
    li .quoted { margin-top: 4px; font: italic 13px/1.45 system-ui, sans-serif; color: var(--muted); overflow-wrap: anywhere; }
    li .edit { margin-top: 4px; font-size: 12px; }
    li .edit summary { cursor: pointer; color: var(--accent); }
    li .edit pre { margin: 4px 0 0; padding: 6px 8px; color: var(--fg); font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap;
      overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
    li .edit .before { background: var(--bad-bg); }
    li .edit .after { background: var(--ok-bg); }
    li .meta { margin-top: 4px; font-size: 12px; color: var(--faint); }
    li .meta a.delete { color: var(--faint); }
    li .meta a.delete:hover { color: var(--bad); }
    li .reply { margin-top: 6px; padding-left: 10px; border-left: 1px solid var(--line); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
    li .act { display: flex; gap: 16px; margin-top: 6px; font-size: 12px; }
    li.archive { padding: 0; border: 0; }
    li.archive summary { padding: 10px 16px; cursor: pointer; font-size: 12px; color: var(--muted); }
    li.archive li { opacity: .75; }
    .updated { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); z-index: 2147483001; display: flex; align-items: center; gap: 12px;
      padding: 6px 6px 6px 14px; background: var(--fill); color: var(--on-fill); font: 600 13px/1.4 system-ui, sans-serif; }
    .updated button { border-color: currentColor; color: inherit; font-weight: 600; }
  </style>
  <button class="open-button" title="${OPEN_HINT}">✎ Note<i hidden title="The notes of this page that are not closed"></i></button>
  <div class="panel" hidden>
    <div class="where"><b>Review</b> · <span title="Your place on the page: a new note keeps it"></span><a href="${esc(CONTENTS)}" title="The table of contents of this folder">☰ Contents</a><button class="close" title="Close the panel (Esc). The draft stays.">✕</button></div>
    <div class="spent" hidden title="What the agents spent on the notes of this page, the archive too: the cost in USD, the count of agent sessions and the time of agent work"></div>
    <div class="agent"><span></span><button class="fix" hidden></button><button class="toggle"></button></div>
    <div class="replying" hidden></div>
    <textarea placeholder="${esc(PLACEHOLDER)}"></textarea>
    <div class="attached" hidden></div>
    <div class="quote" hidden></div>
    <div class="send"><span></span>${Object.entries(MODELS).map(([m, letter], i) =>
      `<button data-model="${esc(m)}" title="Send to ${esc(agentOf(m))}${SEND_KEYS[i] ? ` (${SEND_KEYS[i]})` : ''}">${esc(letter)} Send</button>`).join('')}</div>
    <ol></ol>
  </div>
  <div class="updated" hidden>The page was updated<button>Reload here</button></div>`;
  const $ = s => root.querySelector(s);
  const openButton = $('.open-button'), panel = $('.panel'), draft = $('textarea'), attached = $('.attached'), quote = $('.quote'), list = $('ol'), hint = $('.send span');
  const replying = $('.replying'), fixButton = $('.agent .fix'), closeButton = $('.where .close');
  const HINT = `Ctrl+Enter: ${MODELS[FIRST]}${SECOND ? ` · +Shift: ${MODELS[SECOND]}` : ''}${DOCK ? '' : ' · Esc: close'}`;
  hint.textContent = HINT;
  hint.title = Object.keys(MODELS).map((m, i) => SEND_KEYS[i] && `${SEND_KEYS[i]}: send to ${agentOf(m)}`).filter(Boolean)
    .concat(DOCK ? [] : ['Esc: close the panel, the draft stays']).join('\n');
  document.head.insertAdjacentHTML('beforeend', '<style>[data-review-picked] { outline: 2px solid #2f81f7 !important; outline-offset: 2px !important; }' +
    (DOCK ? `html { margin-right: ${PANEL_PX}px; }` : '') + '</style>');
  document.body.append(host);
  openButton.hidden = closeButton.hidden = DOCK;

  // the keys, clicks and wheel turns in the panel do not go to the page: a deck must not turn a slide when one types a note
  for (const type of ['keydown', 'keyup', 'keypress', 'input', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu'])
    host.addEventListener(type, e => e.stopPropagation(), { passive: true });

  // the draft stays when the page reloads
  const DRAFT = 'review-draft:' + PAGE;
  try { draft.value = sessionStorage.getItem(DRAFT) || ''; } catch { }
  const keepDraft = () => { try { sessionStorage.setItem(DRAFT, draft.value); } catch { } };
  draft.addEventListener('input', keepDraft);

  // Reply mode: the draft becomes a reply to a closed note (the field `re`). It stays when the page reloads, as the draft does.
  const REPLY = 'review-reply:' + PAGE;
  let replyTo = null;
  function replyMode(id) {
    replyTo = id || null;
    try { replyTo ? sessionStorage.setItem(REPLY, replyTo) : sessionStorage.removeItem(REPLY); } catch { }
    replying.hidden = !replyTo;
    replying.innerHTML = replyTo ? `↪ Reply to <b>${esc(replyTo)}</b> <button class="remove" title="Leave the reply mode: the draft becomes a new note">✕</button>` : '';
    draft.placeholder = replyTo ? `What is still wrong after ${replyTo}? An agent reads ${replyTo}, its reply and your reply, and corrects the fix.` : PLACEHOLDER;
  }
  try { replyMode(sessionStorage.getItem(REPLY)); } catch { }
  replying.onclick = e => { if (e.target.closest('button')) { replyMode(null); draft.focus(); } };

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
  closeButton.onclick = () => show(false);
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
    // one thing to point at: a quote stays only when it is a part of the new element
    if (selected && !t.contains(selectedNode)) unselect();
    picked = describe(t, e);
    pickedNode = t;
    t.setAttribute('data-review-picked', '');
    // the picker buttons send a task at once, so they stay behind ⋯
    attached.innerHTML = `📎 <span class="text">${esc(picked.text || picked.path)}</span> <button class="remove" title="Remove">✕</button>` +
      `<button class="more" title="Alt+click picks the wrong part?">⋯</button>` +
      `<div class="picker" hidden><button data-issue="too-big">Can't pick a smaller part</button><button data-issue="wrong">Picks the wrong part</button></div>`;
    attached.hidden = false;
    show(true);
  }, true);
  attached.onclick = e => {
    const b = e.target.closest('button');
    if (b?.classList.contains('remove')) unpick();
    else if (b?.classList.contains('more')) { const p = attached.querySelector('.picker'); p.hidden = !p.hidden; }
    else if (b?.dataset.issue) send(FIRST, b.dataset.issue);
  };

  // ---- Quote the selected text ----

  // A click in the panel clears the selection on the page, so the panel keeps the last text that the reader selected.
  // A new selection replaces it; a plain click on the page that selects nothing, ✕ and "Send" remove it.
  // With an attached element, the quote is a part of it: a selection out of the element removes the element.
  const QUOTE_MAX = 2000;
  let selected = null, selectedNode = null;
  function unselect() {
    selected = selectedNode = null;
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
    if (pickedNode && !pickedNode.contains(t)) unpick();
    selected = { text: text.slice(0, QUOTE_MAX), path: pathOf(t) };
    selectedNode = t;
    const shown = selected.text.length > 200 ? selected.text.slice(0, 200) + '…' : selected.text;
    quote.innerHTML = `❝ <span class="text">${esc(shown)}</span> <button class="remove" title="Do not quote it">✕</button>`;
    quote.hidden = false;
  });
  quote.onclick = e => { if (e.target.closest('button')) unselect(); };

  // ---- Send a note ----

  // an error under the draft; '' shows the keys again
  function warn(text) {
    hint.textContent = text || HINT;
    hint.className = text ? 'error' : '';
  }

  // issue: a picker button; its task goes before the draft
  async function send(model, issue) {
    const text = [issue && PICKER[issue], draft.value.trim()].filter(Boolean).join('\n');
    if (!text) return;
    const p = place();
    const el = picked && (issue ? { ...picked, issue } : picked);
    // a note about the picker is a new task, not a reply
    const re = issue ? null : replyTo;
    try {
      await post('notes', { page: PAGE, text, model, el, sel: selected, re, ctx: { where: where(p), hash: p.hash, w: innerWidth, h: innerHeight } });
    } catch (e) {
      warn('Not sent: ' + e.message);
      return;
    }
    warn('');
    if (re) replyMode(null);
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

  const STATE_COLOR = { working: 'var(--accent)', stopping: 'var(--muted)', idle: 'var(--faint)', stopped: 'var(--bad)', error: 'var(--bad)' };
  const tokens = a => `The tokens: the context of the session. At ${Math.round(a.limit / 1000)}k tokens the next task starts a new session.`;
  const STATE_HINT = {
    working: a => `An agent works on these notes now. Ω: Opus, Σ: Sonnet; o1, s1, …: the agent sessions of Opus and Sonnet. ${tokens(a)}`,
    stopping: () => 'The agent stops. Its notes go back to the queue.',
    idle: a => `No agent works now. For each model: the session that its next task resumes (o1, s1, …) and the context of that session. ${tokens(a)}`,
    stopped: () => 'Stop turned the agent off: it does not start by itself. Fix or Start starts it.',
    error: () => 'The last task failed or closed no note, so the agent does not take the next task by itself. Fix or Start tries again.',
  };
  const TOGGLE_HINT = {
    stop: 'Stop the agent and its start by itself. The notes in work go back to the queue.',
    start: 'Start the agent: it takes the open notes, the oldest first. After new notes, it starts by itself again.',
  };
  // m:ss
  const clock = ms => { const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // agent: the last agent status; autoAt: the time of the start by itself, or null; here: the open notes of this page
  let agent = null, autoAt = null, here = 0;
  // open notes wait, and no agent runs: the Fix button starts the agent now
  const waiting = a => a.open > 0 && a.state !== 'working' && a.state !== 'stopping';
  function showAgent(a) {
    agent = a;
    autoAt = a.autoIn == null ? null : Date.now() + a.autoIn;
    const box = $('.agent'), text = box.querySelector('span'), toggle = box.querySelector('.toggle');
    box.style.setProperty('--state', STATE_COLOR[a.state]);
    // one line, so that a long text does not move the list; the full text is in the tooltip
    text.textContent = 'Agent: ' + a.text;
    text.title = `${a.text}\n\n${STATE_HINT[a.state](a)}`;
    toggle.textContent = a.action === 'stop' ? 'Stop' : 'Start';
    toggle.title = TOGGLE_HINT[a.action];
    toggle.onclick = () => post('agent/' + a.action).then(showAgent).catch(() => {});
    // Fix does what Start does
    toggle.hidden = waiting(a) && a.action === 'start';
    showFix();
  }
  fixButton.onclick = () => post('agent/start').then(showAgent).catch(() => {});
  // the Fix button and the mark on the ✎ button, with the time to the start by itself
  function showFix() {
    const on = !!agent && waiting(agent);
    fixButton.hidden = !on;
    openButton.classList.toggle('due', on);
    if (!on) return void (openButton.title = OPEN_HINT);
    const left = autoAt && Math.max(0, autoAt - Date.now());
    fixButton.textContent = `Fix ${agent.open}${autoAt ? (left ? ` · auto in ${clock(left)}` : ' · starts now') : ''}`;
    const notes = `${agent.open} open note${agent.open === 1 ? '' : 's'}`;
    fixButton.title = `Start the agent now. It fixes the ${notes} of the project (${here} on this page), the oldest first. ` +
      (autoAt ? 'Else it starts by itself at the end of the count; each new note starts the count again.'
        : agent.state === 'stopped' ? 'Stop turned off the start by itself.' : 'It does not start by itself on these notes.');
    openButton.title = `${OPEN_HINT}. ${notes} wait for the agent: open the panel and press Fix` +
      (autoAt ? `, or the agent starts by itself in ${clock(left)}.` : '.');
  }
  setInterval(() => { if (autoAt) showFix(); }, 1000);

  // an edit in the Markdown view: the text before and after; the text of the note is optional
  const edit = e => `<details class="edit"><summary${e.conflict ? ' title="The block changed while you edited it, so the file has the other version. The agent merges your edit into it."' : ''}>` +
    `✎ Edit at line ${esc(e.line)}${e.conflict ? ' · the block changed: the agent merges it' : ''}</summary>` +
    `<pre class="before">${esc(e.before)}</pre><pre class="after">${esc(e.after) || '(removed)'}</pre></details>`;
  // the links under a closed note: in the list, "Reply" and "Looks good"; in the archive, back to the list
  const actions = n => !CLOSED.has(n.status) ? '' : n.accepted
    ? `<div class="act"><a data-unaccept="${esc(n.id)}" title="Move the note back from the archive to the list">Back to the list</a></div>`
    : `<div class="act"><a data-reply="${esc(n.id)}" title="Write a follow-up to this note: an agent corrects or redoes the fix">Reply</a>` +
      `<a data-accept="${esc(n.id)}" title="The result is good: move the note to the archive at the bottom of the list">Looks good</a></div>`;
  function item(n) {
    const by = n.agent && n.status !== 'open'
      ? ` · <span title="Agent session ${esc(n.agent)} ${n.status === 'wip' ? 'works' : 'worked'} on this note">${esc(n.agent)}</span>` : '';
    const status = `<span class="status ${esc(n.status)}" title="${esc(STATUS_HINT[n.status] || '')}">${esc(STATUS[n.status] || n.status)}${by}</span>`;
    const model = MODELS[n.model] ? `<span class="model" title="Sent to ${esc(agentOf(n.model))}">${esc(MODELS[n.model])}</span>` : '';
    const re = n.re ? `<a class="re" data-show="${esc(n.re)}" title="A reply to note ${esc(n.re)}">↪ ${esc(n.re)}</a>` : '';
    const meta = [esc(n.id), esc(n.ctx?.where), n.ctx?.hash && `<a data-go="${esc(bare(n.ctx.hash))}">open here</a>`, esc(spent(n)),
      n.status !== 'wip' && `<a class="delete" data-delete="${esc(n.id)}">delete</a>`].filter(Boolean).join(' · ');
    const quoted = n.sel?.text ? `<div class="quoted">❝ ${esc(n.sel.text.length > 200 ? n.sel.text.slice(0, 200) + '…' : n.sel.text)}</div>` : '';
    return `<li data-id="${esc(n.id)}"><div class="text">${model}${status}${re}${esc(n.text)}</div>${quoted}${n.edit ? edit(n.edit) : ''}<div class="meta">${meta}</div>` +
      (n.reply ? `<div class="reply">${esc(n.reply)}</div>` : '') + actions(n) + '</li>';
  }

  // The list is drawn again only when it changed, so that a scroll, a selection or a hover stays.
  // After a change, the note at the top of the view stays in its place.
  // The accepted notes go to the archive at the bottom, the newest first too.
  let drawn = '', archiveOpen = false;
  function showNotes(notes) {
    const archived = notes.filter(n => n.accepted).reverse();
    const html = notes.filter(n => !n.accepted).reverse().map(item).join('') + (archived.length
      ? `<li class="archive"><details${archiveOpen ? ' open' : ''}><summary title="The notes that you accepted with &quot;Looks good&quot;">` +
        `Archive (${archived.length})</summary><ol>${archived.map(item).join('')}</ol></details></li>` : '');
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
    if (a?.dataset.go) goTo(a.dataset.go, lastNotes.find(n => n.id === a.closest('li')?.dataset.id));
    if (!a?.dataset.delete) return;
    try { await api('notes?id=' + encodeURIComponent(a.dataset.delete), { method: 'DELETE' }); }
    catch (err) { warn(`Not deleted: ${err.message}`); }
    refresh();
  };
  list.addEventListener('toggle', e => { if (e.target.matches('.archive > details')) archiveOpen = e.target.open; }, true);
  // the links of the replies and of the closed notes
  list.addEventListener('click', async e => {
    const d = e.target.closest('a')?.dataset || {};
    if (d.show) showNote(d.show);
    if (d.reply) { replyMode(d.reply); draft.focus(); }
    if (!d.accept && !d.unaccept) return;
    try { await api('accept?id=' + encodeURIComponent(d.accept || d.unaccept), { method: d.accept ? 'POST' : 'DELETE' }); }
    catch (err) { warn('Not changed: ' + err.message); }
    refresh();
  });
  // show a note of the list, also in the archive
  function showNote(id) {
    const li = [...list.querySelectorAll('li[data-id]')].find(x => x.dataset.id === id);
    if (!li) return;
    const archive = li.closest('.archive > details');
    if (archive) archive.open = archiveOpen = true;
    li.scrollIntoView({ block: 'nearest' });
    li.classList.add('shown');
    setTimeout(() => li.classList.remove('shown'), 1500);
  }

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
  let lastNotes = [];  // for "open here"
  async function refresh() {
    let r;
    try { r = await api('page?path=' + encodeURIComponent(PAGE)); } catch { return; }
    lastNotes = r.notes;
    const left = r.notes.filter(n => !CLOSED.has(n.status)).length;
    const badge = openButton.querySelector('i');
    badge.hidden = !left;
    badge.textContent = left;
    watch(r.mtime);
    here = r.notes.filter(n => n.status === 'open').length;
    // also with the panel closed: the ✎ button shows that notes wait for Fix
    showAgent(r.agent);
    if (!isOpen) return;
    if (DOCK) showPlace();  // the Markdown view renders the headings after the panel starts
    showSpent(r.notes);
    showNotes(r.notes);
  }
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  addEventListener('review:refresh', refresh);
})();
