// Markdown view of the review server. markdown-it renders the file; each block gets an edit button in the left margin.
// A block: a top-level block of the file, or an item of a top-level list. It knows its lines in the file.
// A heading has a second button for its whole section (up to the next heading of the same or a higher level),
// and a top-level list has a button for the whole list.
// LaTeX math, \[ … \], $$ … $$ and \( … \), is rendered with KaTeX.
// "Save" sends the edit to the server: the server changes the file at once, and a note asks the agent to finish the edit.
// When the file changes, the panel sends `review:changed`, and the view renders the file again.
(() => {
  const { page: PAGE, models, project: PROJECT } = document.currentScript.dataset;
  const MODELS = JSON.parse(models), [FIRST, SECOND] = Object.keys(MODELS);
  const HINT = `Ctrl+Enter: ${MODELS[FIRST]}${SECOND ? ` · +Shift: ${MODELS[SECOND]}` : ''} · Esc: cancel`;
  const doc = document.querySelector('.doc'), file = document.querySelector('.file'), error = document.querySelector('.error');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const squash = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const BUTTON = '<button class="edit" title="Edit this block"></button>';
  const WIDE = {
    section: '<button class="edit wide section" title="Edit the whole section"></button>',
    list: '<button class="edit wide list" title="Edit the whole list"></button>',
  };

  // the path of the file: the project and each folder link to their tables of contents
  const parts = PAGE.split('/');
  const folder = i => '/' + parts.slice(0, i).map(p => encodeURIComponent(p) + '/').join('');
  file.innerHTML = [`<a href="/" title="The table of contents of the project">${esc(PROJECT)}</a>`,
    ...parts.slice(0, -1).map((p, i) => `<a href="${folder(i + 1)}" title="The table of contents of this folder">${esc(p)}</a>`),
    `<b>${esc(parts.at(-1))}</b>`].join(' / ');
  const fail = text => { error.textContent = text; error.hidden = false; };

  let source = '';  // the text of the file as the view shows it
  const lines = () => source.split(/\r?\n/);

  // ---- Render ----

  const md = window.markdownit?.({ html: true, linkify: true }), Token = md?.core.State.prototype.Token;
  if (md) {
    md.renderer.rules.review_open = (tokens, i) => {
      const { from, to, end, wide } = tokens[i].meta;
      return `<div class="block${wide === 'list' ? ' list' : ''}" data-from="${from}" data-to="${to}" data-end="${end ?? to}">` +
        (wide === 'list' ? '' : BUTTON) + (WIDE[wide] || '');
    };
    md.renderer.rules.review_close = () => '</div>';
    const item = md.renderer.rules.list_item_open || ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
    md.renderer.rules.list_item_open = (tokens, i, ...rest) => item(tokens, i, ...rest) + (tokens[i].attrGet('data-from') === null ? '' : BUTTON);
    math(md);
  }

  // ---- Math ----

  // LaTeX math as LLMs and Pandoc write it: \[ … \] and $$ … $$ are display formulas, \( … \) is a formula in the text.
  // \[ or $$ at the start of a line opens a block, and the block ends at the line that ends with \] or $$;
  // a blank line breaks it. In the middle of a line, \[ … \] and $$ … $$ stay text: "\[1\]" is often a pair of escaped brackets.
  // KaTeX renders the formulas; without KaTeX, the view shows their source.
  function math(md) {
    const DISPLAY = [['\\[', '\\]'], ['$$', '$$']];
    const tex = (text, display) => window.katex
      ? katex.renderToString(text, { displayMode: display, throwOnError: false })
      : `<code>${esc(display ? `\\[${text}\\]` : `\\(${text}\\)`)}</code>`;

    md.block.ruler.before('paragraph', 'math_block', (state, start, end, silent) => {
      if (state.sCount[start] - state.blkIndent >= 4) return false;
      const line = n => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n]).trimEnd();
      const first = line(start), [open, close] = DISPLAY.find(([o]) => first.startsWith(o)) || [];
      if (!open) return false;
      const parts = [first.slice(open.length)];
      let last = start;
      while (!parts.at(-1).endsWith(close)) {
        if (++last >= end || state.isEmpty(last) || state.sCount[last] < state.blkIndent) return false;
        parts.push(line(last));
      }
      const text = parts.join('\n').slice(0, -close.length);
      if (text.includes(close) || !text.trim()) return false;
      if (silent) return true;
      const token = state.push('math_block', 'math', 0);
      Object.assign(token, { block: true, content: text, markup: open, map: [start, last + 1] });
      state.line = last + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    // before "escape": else \( becomes (
    md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
      const { src, pos } = state;
      if (!src.startsWith('\\(', pos)) return false;
      const close = src.indexOf('\\)', pos + 2);
      if (close < 0 || close + 2 > state.posMax || !src.slice(pos + 2, close).trim()) return false;
      if (!silent) state.push('math_inline', 'math', 0).content = src.slice(pos + 2, close);
      state.pos = close + 2;
      return true;
    });

    md.renderer.rules.math_block = (tokens, i) => `<div class="math-block">${tex(tokens[i].content, true)}</div>\n`;
    md.renderer.rules.math_inline = (tokens, i) => tex(tokens[i].content, false);
  }

  // the blocks of the parsed tokens; shift: the count of the lines before the parsed text (the front matter); total: the lines of the file
  function blocks(tokens, shift, total) {
    const out = [], ids = new Map(), headings = [];
    for (let i = 0; i < tokens.length; i++) {
      let j = i;
      if (tokens[i].nesting === 1) while (!(tokens[j].level === 0 && tokens[j].nesting === -1)) j++;
      const span = tokens.slice(i, j + 1), first = tokens[i];
      i = j;
      // a heading gets an id from its text, so that the panel takes the place from the headings
      span.forEach((t, k) => { if (t.type === 'heading_open') t.attrSet('id', slug(span[k + 1], ids)); });
      if (!first.map) { out.push(...span); continue; }
      const open = new Token('review_open', '', 1);
      open.meta = { from: first.map[0] + shift, to: first.map[1] + shift };
      if (first.type === 'heading_open') {
        open.meta.wide = 'section';
        open.meta.level = +first.tag.slice(1);
        headings.push(open.meta);
      }
      if (first.type === 'bullet_list_open' || first.type === 'ordered_list_open') {
        open.meta.wide = 'list';
        for (const t of span) if (t.type === 'list_item_open' && t.level === 1) {
          t.attrSet('class', 'block');
          t.attrSet('data-from', t.map[0] + shift);
          t.attrSet('data-to', t.map[1] + shift);
        }
      }
      out.push(open, ...span, new Token('review_close', '', -1));
    }
    // a section ends where the next heading of the same or a higher level starts, or at the end of the file
    headings.forEach((h, k) => { h.end = headings.slice(k + 1).find(n => n.level <= h.level)?.from ?? total; });
    return out;
  }

  // the id of a heading, as GitHub makes it: the words of the text in lower case, with "-" between them
  function slug(inline, ids) {
    const text = (inline.children || []).filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join('');
    const base = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
    const n = ids.get(base) || 0;
    ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  }

  function render() {
    if (!md) {
      fail('markdown-it did not load (no internet?), so the file is shown as text.');
      doc.innerHTML = `<pre>${esc(source)}</pre>`;
      return;
    }
    // a YAML front matter is a block too
    const front = source.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)?.[0] || '';
    const shift = front ? front.split(/\r?\n/).length - (/\n$/.test(front) ? 1 : 0) : 0;
    const env = {};
    doc.innerHTML = (front ? `<div class="block" data-from="0" data-to="${shift}" data-end="${shift}">${BUTTON}<pre class="front-matter">${esc(front)}</pre></div>` : '') +
      md.renderer.render(blocks(md.parse(source.slice(front.length), env), shift, lines().length), md.options, env);
  }

  // stale: the file changed during an edit; the view renders it again when the edit ends
  let editing = null, stale = false;
  async function load() {
    if (editing) return void (stale = true);
    const r = await fetch(location.pathname + '?raw', { cache: 'no-store' });
    if (!r.ok) return fail(`${r.status} ${r.statusText}`);
    error.hidden = true;
    const text = await r.text();
    // the same text: the view stays, with the hover and the selection
    if (text === source && doc.childElementCount) return;
    source = text;
    render();
  }

  // ---- Edit a block ----

  // the place of a block for the note: the heading of its section and the lines
  const linesOf = (from, to) => (to - from > 1 ? `lines ${from + 1}–${to}` : `line ${from + 1}`);
  function placeOf(block, from, to) {
    const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter(h => block.contains(h) || h.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING);
    const h = headings.at(-1);
    return { where: [h && squash(h.textContent).slice(0, 100), linesOf(from, to)].filter(Boolean).join(' · '), hash: h?.id || '' };
  }

  // wide: edit the whole section of a heading or the whole list, not only the block
  function edit(block, wide) {
    if (editing) return editing.querySelector('textarea').focus();
    let from = +block.dataset.from, to = +(wide ? block.dataset.end : block.dataset.to);
    const all = lines();
    while (to > from + 1 && !all[to - 1].trim()) to--;  // a block can end with empty lines
    const before = all.slice(from, to).join('\n');
    // the elements that the editor takes the place of: the block, and for a section each block up to its end
    const hide = [block];
    if (wide) for (let n = block.nextElementSibling; n && !(+n.dataset.from >= to); n = n.nextElementSibling) hide.push(n);
    const ctx = { ...placeOf(block, from, to), w: innerWidth, h: innerHeight };
    const box = document.createElement(block.localName === 'li' ? 'li' : 'div');
    box.className = 'editor';
    box.innerHTML = `<textarea spellcheck="true"></textarea>` +
      `<input placeholder="A note to the agent (optional)"><div class="row"><span>${esc(HINT)}</span>` +
      Object.entries(MODELS).map(([m, letter]) => `<button data-model="${esc(m)}" title="Save: a ${esc(m)} agent finishes the edit">${esc(letter)} Save</button>`).join('') +
      '<button class="cancel">Cancel</button></div>';
    block.before(box);
    hide.forEach(n => { n.hidden = true; });
    editing = box;
    const text = box.querySelector('textarea'), note = box.querySelector('input'), hint = box.querySelector('span');
    const fit = () => { text.style.height = 'auto'; text.style.height = text.scrollHeight + 2 + 'px'; };
    text.value = before;
    text.addEventListener('input', fit);
    fit();
    text.focus();

    const close = () => {
      editing = null;
      box.remove();
      hide.forEach(n => { n.hidden = false; });
      if (stale) { stale = false; load(); }
    };
    async function save(model) {
      const after = text.value.replace(/\s+$/, ''), comment = note.value.trim();
      if (after === before && !comment) return close();
      // no change, only a note: a plain note about the block
      const [path, body] = after === before
        ? ['notes', { page: PAGE, text: comment, model, ctx, el: { text: squash(before).slice(0, 160), path: linesOf(from, to) } }]
        : ['edit', { page: PAGE, from, before, after, text: comment, model, ctx }];
      const r = await fetch('/__review/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const answer = await r.json().catch(() => ({}));
      if (!r.ok) {
        hint.textContent = `Not saved: ${answer.error || r.statusText}. Copy the text, cancel and edit again.`;
        hint.className = 'error';
        return;
      }
      // the answer to an edit has the new text of the file; the answer to a note is the note
      if (path === 'notes') close();
      else { editing = null; stale = false; source = answer.text; render(); }
      dispatchEvent(new Event('review:refresh'));
    }
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(e.shiftKey && SECOND ? SECOND : FIRST); }
    });
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b?.dataset.model) save(b.dataset.model);
      else if (b?.classList.contains('cancel')) close();
    });
  }

  doc.addEventListener('click', e => {
    const b = e.target.closest('button.edit');
    if (b && !e.altKey) edit(b.closest('.block'), b.classList.contains('wide'));
  });

  // the panel saw a change of the file: the view shows it, so the panel shows no banner
  addEventListener('review:changed', e => { e.preventDefault(); load(); });

  load().then(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  });
})();
