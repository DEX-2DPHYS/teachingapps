// Text boxes typed directly on a page, shared by the lecturer's whiteboard and the student viewer.
// A box: { id, x, y, w, font, size, color, html } in page units (the page is 1200 wide for A4
// portrait). w = null: the box grows with the text (no wrapping); after the box is reselected its
// right edge can be dragged, which sets w and makes the text wrap. html is limited rich text (bold,
// italic, colour and font size per letter), always passed through sanitize().
//
// The layer sits over the page, scaled like the ink (setScale). With the text tool on (setActive)
// a click on an empty spot starts a new box, a click on a box edits it, a click elsewhere ends the
// editing (an empty box disappears). A small format bar floats above the box being edited.

export const FONTS = {
  sans: ['Sans', 'system-ui, "Segoe UI", Arial, sans-serif'],
  serif: ['Serif', 'Cambria, Georgia, "Times New Roman", serif'],
  mono: ['Mono', 'Consolas, "Courier New", monospace'],
  hand: ['Hand', '"Segoe Print", "Comic Sans MS", cursive'],
};
export const SIZES = [12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 128];

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// the element where a selection starts (its font size is the selection's size)
const nodeOf = r => { let n = r.startContainer; if (n.nodeType === 1 && n.childNodes[r.startOffset]) n = n.childNodes[r.startOffset]; return n.nodeType === 1 ? n : n.parentElement; };
const newId = () => 't' + Math.random().toString(36).slice(2, 10);

// ----------------------------------------------------------------------------------- sanitize
// Only what the format bar can make survives: b, i, u, line breaks and spans with font size,
// colour, bold or italic. Everything else is unwrapped to its text. Used for everything shown,
// so a box received from somebody else can never carry scripts, links or images.
const KEEP = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', BR: 'br', DIV: 'div', P: 'div', SPAN: 'span', FONT: 'span' };
function cleanStyle(el) {
  const out = [];
  const fs = parseFloat(el.style?.fontSize);
  if (fs >= 6 && fs <= 400) out.push(`font-size:${Math.round(fs * 10) / 10}px`);
  const col = el.style?.color || (el.tagName === 'FONT' ? el.getAttribute('color') : '');
  if (col && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(col.trim())) out.push(`color:${col.trim()}`);
  if (/^(bold|[6-9]00)$/.test(el.style?.fontWeight || '')) out.push('font-weight:bold');
  if (el.style?.fontStyle === 'italic') out.push('font-style:italic');
  return out.join(';');
}
export function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  const walk = node => {
    let s = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { s += esc(n.data); continue; }
      if (n.nodeType !== 1) continue;
      // typeset maths ("Convert to LaTeX"): only its LaTeX source is kept; it is typeset again by
      // fillMath, so stored or received HTML never gets into the page
      if (n.tagName === 'SPAN' && n.classList.contains('tx-math') && n.dataset.tex) {
        const src = n.dataset.src ? ` data-src="${esc(n.dataset.src.slice(0, 2000))}"` : '';
        s += `<span class="tx-math" contenteditable="false" data-tex="${esc(n.dataset.tex.slice(0, 2000))}"${src}></span>`;
        continue;
      }
      // an answer to "= ?" in the text (see questions / placeAnswer): kept the same way
      if (n.tagName === 'SPAN' && n.classList.contains('tx-answer') && n.dataset.tex) {
        const cls = ['calc', 'ai'].includes(n.dataset.cls) ? n.dataset.cls : 'calc';
        const where = n.dataset.where === 'math' ? 'math' : 'text';
        s += `<span class="tx-answer" contenteditable="false" data-tex="${esc(n.dataset.tex.slice(0, 2000))}" data-cls="${cls}" data-where="${where}" data-marker="${esc((n.dataset.marker || '?').slice(0, 40))}" data-label="${esc((n.dataset.label || '').slice(0, 200))}"></span>`;
        continue;
      }
      const tag = KEEP[n.tagName];
      const inner = walk(n);
      if (!tag) { s += inner; continue; }
      if (tag === 'br') { s += '<br>'; continue; }
      const st = cleanStyle(n);
      if (tag === 'span' && !st) { s += inner; continue; }
      s += `<${tag}${st ? ` style="${st}"` : ''}>${inner}</${tag}>`;
    }
    return s;
  };
  return walk(tpl.content);
}
// the text of a box, lines as \n; typeset maths as $latex$
export const plainText = html => {
  const d = document.createElement('div');
  d.innerHTML = sanitize(html).replace(/<br>/g, '\n').replace(/<\/div>/g, '</div>\n');
  d.querySelectorAll('.tx-math, .tx-answer').forEach(m => { m.textContent = `$${m.dataset.tex}$`; });
  return d.textContent.replace(/\n+$/, '');
};
// the text of a piece of a box (a DOM fragment), as plainText does it
const fragText = frag => { const d = document.createElement('div'); d.appendChild(frag); return plainText(d.innerHTML); };
const modeOf = k => ({ AI: 'ai', N: 'num', S: 'sym' }[k] || 'calc');
// typeset every maths span below root (KaTeX when loaded, else the LaTeX source)
export function fillMath(root) {
  for (const m of root.querySelectorAll('.tx-math, .tx-answer')) {
    if (m.dataset.done === m.dataset.tex) continue;
    try { m.innerHTML = globalThis.katex ? globalThis.katex.renderToString(m.dataset.tex, { throwOnError: false, strict: false }) : esc(`$${m.dataset.tex}$`); }
    catch { m.textContent = `$${m.dataset.tex}$`; }
    m.dataset.done = m.dataset.tex;
    m.title = m.classList.contains('tx-answer')
      ? `${m.dataset.label || 'answer'}. Double-click (while editing) to ask again.`
      : 'Typeset maths. Double-click (while editing) to get the typed text back.';
  }
}
// "text with $maths$" -> box HTML: text escaped, maths as spans; src = the typed text of a single formula
function latexToHtml(s, src) {
  return String(s).split(/(\$\$[\s\S]+?\$\$|\$[^$]+?\$)/g).map(p => {
    const m = p.match(/^\$\$?([\s\S]+?)\$?\$$/);
    if (m && p.length > 2) return `<span class="tx-math" contenteditable="false" data-tex="${esc(m[1].trim())}"${src ? ` data-src="${esc(src)}"` : ''}></span>`;
    return esc(p).replace(/\n/g, '<br>');
  }).join('');
}

// ----------------------------------------------------------------------------------- styles
// (in the module, so the whiteboard and the viewer look the same without sharing a stylesheet)
const CSS = `
.tx-box.locked .tx-grip, .tx-box.locked .tx-resize { display: none !important; }
.tx-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; z-index: 6; }
.tx-layer.active { pointer-events: auto; cursor: text; }
.tx-layer[hidden] { display: none; }
.tx-box { position: absolute; pointer-events: none; }
.tx-layer.active .tx-box { pointer-events: auto; }
.tx-content { outline: none; white-space: pre; line-height: 1.25; min-width: .6em; min-height: 1.25em; padding: 2px 6px; }
.tx-box.fixed .tx-content { white-space: pre-wrap; overflow-wrap: anywhere; }
.tx-layer.active .tx-box:hover { outline: 1.5px dashed rgba(31,95,209,.45); }
.tx-box.editing { outline: 2px dashed #1f5fd1 !important; background: rgba(255,255,255,.08); }
.tx-grip, .tx-resize { display: none; position: absolute; user-select: none; touch-action: none; }
.tx-box.editing:not(.fresh) .tx-grip, .tx-box.editing:not(.fresh) .tx-resize { display: block; }
.tx-grip { left: -34px; top: -2px; width: 30px; height: 30px; line-height: 30px; text-align: center; font: 22px system-ui, sans-serif;
  color: #fff; background: #1f5fd1; border-radius: 6px; cursor: move; }
.tx-resize { right: -9px; top: 0; bottom: 0; width: 14px; cursor: ew-resize; }
.tx-resize::after { content: ''; position: absolute; left: 4px; top: 20%; bottom: 20%; width: 6px; border-radius: 3px; background: #1f5fd1; }
.tx-bar { position: absolute; z-index: 30; display: flex; align-items: center; gap: 3px; flex-wrap: nowrap; white-space: nowrap;
  padding: 4px; border-radius: 8px; background: var(--panel, #fff); color: var(--text, #1d1d1f);
  border: 1px solid var(--line, #d0d0cc); box-shadow: 0 4px 16px rgba(0,0,0,.22); font: 13px system-ui, sans-serif; }
.tx-bar[hidden] { display: none; }
.tx-bar select, .tx-bar button { font: inherit; padding: 3px 6px; border-radius: 5px; border: 1px solid var(--line, #d0d0cc);
  background: var(--btn, #fff); color: inherit; cursor: pointer; }
.tx-bar button:hover { background: var(--btn-hover, #ececea); }
.tx-math, .tx-answer { white-space: nowrap; }
.tx-answer { color: #2e7d32; }
.tx-answer[data-cls=ai] { color: #8e24aa; }
.tx-box.editing .tx-answer { cursor: pointer; background: rgba(46,125,50,.10); border-radius: 4px; }
.tx-box.editing .tx-math { cursor: pointer; background: rgba(31,95,209,.10); border-radius: 4px; }
.tx-colors { display: inline-flex; gap: 3px; margin: 0 2px; }
.tx-bar .tx-swatch { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 2px solid var(--panel, #fff); box-shadow: 0 0 0 1px var(--line, #bbb); }
@media print { .tx-bar, .tx-grip, .tx-resize { display: none !important; } .tx-box.editing { outline: none !important; } }
`;
let cssDone = false;
function addCss() {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ----------------------------------------------------------------------------------- the layer
export class TextLayer {
  // sheet: the element the page is drawn in (position: relative)
  // opts: { editable, onChange(), colors: () => [[key, css]], autoColor: () => css,
  //         defaults: () => ({ font, size, color }), extras: [{ label, title, run(box, layer) }] }
  constructor(sheet, opts = {}) {
    addCss();
    this.sheet = sheet;
    this.o = { editable: true, onChange: () => {}, notify: () => {}, onFinish: () => {}, colors: () => [['auto', '#1b1b1b']], autoColor: () => '#1b1b1b', defaults: () => ({}), extras: [], ...opts };
    this.texts = [];
    this.s = 1; this.W = 1200; this.H = 1697;
    this.els = new Map(); // id -> element
    this.editing = null;  // the box being edited
    this.range = null;    // the last selection inside it (the bar's select menus take the focus)
    this.el = document.createElement('div');
    this.el.className = 'tx-layer';
    sheet.appendChild(this.el);
    if (this.o.editable) this.wire();
  }

  // the array of boxes of the page on screen (kept by reference: edits change it in place)
  setTexts(texts) {
    if (this.editing && !texts.includes(this.editing)) this.finish();
    this.texts = texts || [];
    this.render();
  }
  setScale(s, W, H) {
    this.s = s; this.W = W; this.H = H;
    Object.assign(this.el.style, { width: W + 'px', height: H + 'px', transform: `scale(${s})` });
    this.placeBar();
  }
  setActive(on) {
    this.active = !!on;
    this.el.classList.toggle('active', this.active);
    if (!on) this.finish();
  }
  setHidden(h) { this.el.hidden = !!h; if (h) this.finish(); }

  boxCss(t) {
    // the box colour is a palette name (so it follows white/blackboard), or a CSS colour
    const col = !t.color || t.color === 'auto' ? this.o.autoColor() : this.o.colors().find(([k]) => k === t.color)?.[1] || t.color;
    return `left:${t.x}px;top:${t.y}px;${t.w ? `width:${t.w}px;` : ''}font-family:${(FONTS[t.font] || FONTS.sans)[1]};font-size:${t.size || 32}px;color:${col}`;
  }
  render() {
    const seen = new Set();
    for (const t of this.texts) {
      seen.add(t.id);
      let el = this.els.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tx-box';
        el.dataset.id = t.id;
        el.innerHTML = '<div class="tx-content"></div>' + (this.o.editable ? '<div class="tx-grip" title="Drag to move">✥</div><div class="tx-resize" title="Drag to change the width (the text reflows)"></div>' : '');
        this.el.appendChild(el);
        this.els.set(t.id, el);
      }
      el.style.cssText = this.boxCss(t);
      el.classList.toggle('fixed', !!t.w);
      el.classList.toggle('locked', !!t.lock);
      if (t !== this.editing) { el.firstChild.innerHTML = sanitize(t.html); fillMath(el.firstChild); }
    }
    for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
  }

  // ---------------------------------------------------------------------------- editing
  wire() {
    this.bar = document.createElement('div');
    this.bar.className = 'tx-bar';
    this.bar.hidden = true;
    this.sheet.appendChild(this.bar);

    this.el.addEventListener('pointerdown', e => {
      if (!this.active) return;
      const box = e.target.closest('.tx-box');
      if (e.target.closest('.tx-grip')) { this.drag(e, box, 'move'); return; }
      if (e.target.closest('.tx-resize')) { this.drag(e, box, 'width'); return; }
      const t = box && this.texts.find(x => x.id === box.dataset.id);
      if (t && !t.lock) {
        if (t !== this.editing) { this.finish(); this.edit(t, false); }
        return; // the click places the caret
      }
      // a locked box (an assignment's task, a hand-in under review) is like an empty spot: a new box
      e.preventDefault();
      if (this.editing) { this.finish(); return; } // a click elsewhere ends the editing
      const r = this.el.getBoundingClientRect();
      this.add((e.clientX - r.left) / this.s, (e.clientY - r.top) / this.s);
    });
    this.el.addEventListener('dblclick', e => {
      if (!this.editing) return;
      const a = e.target.closest('.tx-answer'), m = e.target.closest('.tx-math');
      if (a) { e.preventDefault(); this.unanswer(a); } else if (m) { e.preventDefault(); this.unconvert(m); }
    });
    // a click outside the box and its bar ends the editing
    document.addEventListener('pointerdown', e => {
      if (!this.editing) return;
      if (e.target.closest('.tx-bar') === this.bar || e.target.closest('.tx-box') === this.els.get(this.editing.id)) return;
      if (this.el.contains(e.target)) return; // handled above
      this.finish();
    }, true);
    document.addEventListener('selectionchange', () => {
      const c = this.content();
      const sel = getSelection();
      if (c && sel.rangeCount && c.contains(sel.getRangeAt(0).commonAncestorContainer)) { this.range = sel.getRangeAt(0).cloneRange(); this.syncBar(); }
    });
    this.bar.addEventListener('pointerdown', e => { if (e.target.tagName !== 'SELECT') e.preventDefault(); e.stopPropagation(); });
    this.bar.addEventListener('click', e => {
      const b = e.target.closest('[data-tx]');
      if (!b || !this.editing) return;
      const a = b.dataset.tx;
      if (a === 'bold' || a === 'italic') this.format(() => document.execCommand(a), a);
      else if (a === 'bigger' || a === 'smaller') this.step(a === 'bigger' ? 1 : -1);
      else if (a === 'color') this.color(b.dataset.key, b.dataset.css);
      else if (a === 'delete') this.remove(this.editing);
      else if (a.startsWith('x')) this.o.extras[+a.slice(1)]?.run(this.editing, this, b);
    });
    this.bar.addEventListener('change', e => {
      if (!this.editing) return;
      if (e.target.dataset.tx === 'font') { this.editing.font = e.target.value; this.changed(); this.focus(); }
      if (e.target.dataset.tx === 'size') this.setSize(+e.target.value);
    });
  }

  content() { return this.editing ? this.els.get(this.editing.id)?.firstChild : null; }

  add(x, y) {
    const d = this.o.defaults() || {};
    const t = { id: newId(), x: Math.round(x), y: Math.round(y - (d.size || 32) * 0.65), w: null, font: d.font || 'sans', size: d.size || 32, color: d.color || 'auto', html: '' };
    this.texts.push(t);
    this.render();
    this.edit(t, true);
    return t;
  }

  edit(t, fresh) {
    this.editing = t;
    const el = this.els.get(t.id);
    el.classList.add('editing');
    el.classList.toggle('fresh', !!fresh);
    const c = el.firstChild;
    c.contentEditable = 'true';
    c.spellcheck = false;
    c.oninput = () => { t.html = sanitize(c.innerHTML); this.placeBar(); this.changed(); };
    c.onkeydown = e => { if (e.key === 'Escape') { e.preventDefault(); this.finish(); } };
    c.onpaste = e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); };
    this.buildBar();
    if (fresh) this.focus(true);
  }

  focus(toEnd) {
    const c = this.content();
    if (!c) return;
    c.focus({ preventScroll: true });
    const sel = getSelection();
    if (toEnd || !this.range) { const r = document.createRange(); r.selectNodeContents(c); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
    else { sel.removeAllRanges(); sel.addRange(this.range); }
  }

  finish() {
    const t = this.editing;
    if (!t) return;
    const el = this.els.get(t.id);
    this.editing = null;
    this.range = null;
    if (this.bar) this.bar.hidden = true;
    if (el) {
      el.classList.remove('editing', 'fresh');
      const c = el.firstChild;
      c.contentEditable = 'false';
      c.oninput = c.onkeydown = c.onpaste = null;
      t.html = sanitize(c.innerHTML);
    }
    if (!plainText(t.html).trim()) { this.remove(t); return; }
    this.render();
    this.changed();
    this.o.onFinish(t); // e.g. answer the "= ?" in it
  }

  // ---------------------------------------------------------------------------- "= ?" in the text
  // Questions in a box: a text piece "... = ?" (also "= ???", "= □", with N / S / AI after it), or
  // typeset maths ending in "= ?" / "= \square". expr = the line up to and with the marker.
  questions(t) {
    const el = this.els.get(t.id);
    if (!el) return [];
    const c = el.firstChild, out = [];
    const lineBefore = (node, offset) => { const r = document.createRange(); r.setStart(c, 0); if (offset == null) r.setEndBefore(node); else r.setEnd(node, offset); return fragText(r.cloneContents()).split('\n').pop(); };
    const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, { acceptNode: n => (n.parentElement.closest('.tx-math, .tx-answer') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    for (let n; (n = walker.nextNode());) {
      for (const m of n.data.matchAll(/=\s*(\?+|□)\s*(AI|N|S)?(?![\p{L}\d?])/gu)) {
        const start = m.index + m[0].indexOf(m[1]), end = m.index + m[0].length;
        out.push({ where: 'text', node: n, start, end, marker: n.data.slice(start, end), mode: modeOf(m[2]), expr: lineBefore(n, end).trim() });
      }
    }
    for (const s of c.querySelectorAll('.tx-math')) {
      const tex = s.dataset.tex;
      const m = tex.match(/=\s*(\?+|\\square|\\Box|□)\s*(?:\\(?:text|mathrm)\{\s*(AI|N|S)\s*\}|(AI|N|S))?\s*$/);
      if (!m) continue;
      out.push({ where: 'math', node: s, marker: tex.slice(m.index + m[0].indexOf(m[1])), mode: modeOf(m[2] || m[3]), expr: (lineBefore(s) + `$${tex}$`).trim() });
    }
    return out;
  }
  // put an answer {latex, label, cls} in place of the marker of the question with this expr
  placeAnswer(t, expr, v) {
    const q = this.questions(t).find(x => x.expr === expr);
    if (!q) return false;
    const c = this.els.get(t.id).firstChild;
    const span = document.createElement('span');
    span.className = 'tx-answer';
    span.contentEditable = 'false';
    Object.assign(span.dataset, { tex: v.latex, cls: v.cls === 'ai' ? 'ai' : 'calc', label: v.label || '', marker: q.marker, where: q.where });
    if (q.where === 'text') {
      const r = document.createRange();
      r.setStart(q.node, q.start); r.setEnd(q.node, q.end);
      r.deleteContents();
      r.insertNode(span);
    } else {
      const s = q.node;
      s.dataset.tex = s.dataset.tex.slice(0, s.dataset.tex.length - q.marker.length).trimEnd();
      delete s.dataset.done;
      s.after(span);
      s.after(document.createTextNode(' '));
    }
    fillMath(c);
    t.html = sanitize(c.innerHTML);
    this.changed();
    return true;
  }
  // double-click on an answer while editing: the marker comes back (and is asked again on leaving)
  unanswer(a) {
    const c = this.content();
    if (!c || !c.contains(a)) return;
    let back;
    if (a.dataset.where === 'math') {
      let s = a.previousSibling;
      if (s && s.nodeType === 3 && !s.data.trim()) { const sp = s; s = s.previousSibling; sp.remove(); }
      if (s?.classList?.contains('tx-math')) { s.dataset.tex += ' ' + a.dataset.marker; delete s.dataset.done; }
      back = document.createTextNode('');
    } else back = document.createTextNode(a.dataset.marker || '?');
    a.replaceWith(back);
    fillMath(c);
    const r = document.createRange(); r.setStartAfter(back); r.collapse(true); this.range = r; this.focus();
    this.editing.html = sanitize(c.innerHTML);
    this.changed();
  }

  remove(t) {
    const i = this.texts.indexOf(t);
    if (i >= 0) this.texts.splice(i, 1);
    if (this.editing === t) { this.editing = null; this.range = null; if (this.bar) this.bar.hidden = true; }
    this.render();
    this.changed();
  }

  changed() { this.o.onChange(); }

  // ---------------------------------------------------------------------------- formatting
  // a selection of letters inside the box, or null (then the whole box is meant)
  selection() {
    const c = this.content(), r = this.range;
    return c && r && !r.collapsed && c.contains(r.commonAncestorContainer) ? r : null;
  }
  // a selection of all the text in the box (then a size change goes to the box, so lines space with it)
  selectionIsAll(r) {
    const c = this.content();
    return !!(c && r) && r.toString().replace(/\s+/g, '') === c.textContent.replace(/\s+/g, '');
  }
  // run an execCommand on the selection, or on the whole box when nothing is selected
  format(cmd) {
    const c = this.content();
    const part = this.selection();
    this.focus();
    const sel = getSelection();
    if (!part) { const r = document.createRange(); r.selectNodeContents(c); sel.removeAllRanges(); sel.addRange(r); }
    document.execCommand('styleWithCSS', false, true);
    cmd();
    if (!part) sel.collapseToEnd();
    this.editing.html = sanitize(c.innerHTML);
    this.changed();
    this.syncBar();
  }
  color(key, css) {
    const t = this.editing, c = this.content();
    if (!this.selection()) {
      // the whole box: its colour, and no colours on single letters any more
      t.color = key;
      c.querySelectorAll('[style]').forEach(x => { x.style.color = ''; });
      c.querySelectorAll('font[color]').forEach(x => x.removeAttribute('color'));
      t.html = sanitize(c.innerHTML);
      this.render(); this.changed(); this.focus();
      return;
    }
    this.format(() => document.execCommand('foreColor', false, key === 'auto' ? this.o.autoColor() : css));
  }
  // font size: selected letters, or the whole box (single letters keep their size relative to it)
  setSize(v) {
    const part = this.selection();
    if (part && !this.selectionIsAll(part)) { this.sizeRange(v); return; }
    const t = this.editing, c = this.content();
    t.size = v;
    c.querySelectorAll('[style]').forEach(x => { x.style.fontSize = ''; });
    t.html = sanitize(c.innerHTML);
    this.render(); this.changed(); this.focus(); this.syncBar();
  }
  step(dir) {
    const next = cur => (dir > 0 ? SIZES.find(v => v > cur + 0.5) || SIZES[SIZES.length - 1] : [...SIZES].reverse().find(v => v < cur - 0.5) || SIZES[0]);
    const part = this.selection();
    if (part && !this.selectionIsAll(part)) {
      this.sizeRange(next(parseFloat(getComputedStyle(nodeOf(part)).fontSize)));
      return;
    }
    const t = this.editing, c = this.content();
    const v = next(t.size), f = v / t.size;
    t.size = v;
    c.querySelectorAll('[style]').forEach(x => { const fs = parseFloat(x.style.fontSize); if (fs) x.style.fontSize = Math.round(fs * f) + 'px'; });
    t.html = sanitize(c.innerHTML);
    this.render(); this.changed(); this.focus(); this.syncBar();
  }
  sizeRange(v) {
    const c = this.content();
    this.focus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand('fontSize', false, '7'); // marks the selection with <font size="7">
    const made = [];
    for (const f of c.querySelectorAll('font[size="7"]')) {
      const sp = document.createElement('span');
      sp.style.fontSize = v + 'px';
      if (f.getAttribute('color')) sp.style.color = f.getAttribute('color');
      sp.append(...f.childNodes);
      sp.querySelectorAll('[style]').forEach(x => { x.style.fontSize = ''; });
      f.replaceWith(sp);
      made.push(sp);
    }
    if (made.length) { // keep the same letters selected, so A+ / A− can be pressed again
      const r = document.createRange();
      r.setStartBefore(made[0]); r.setEndAfter(made[made.length - 1]);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      this.range = r.cloneRange();
    }
    this.editing.html = sanitize(c.innerHTML);
    this.changed();
    this.syncBar();
  }

  // ---------------------------------------------------------------------------- Convert to LaTeX
  // The selected letters (one formula), or the whole box (text with maths in it), are sent to
  // fn(text, mode) -> { text: 'with $latex$', note }, and replaced by the result. Double-click on
  // the maths brings back the typed text of a converted selection (or the LaTeX of a converted box).
  async convertLatex(fn, btn) {
    const t = this.editing, c = this.content();
    if (!t || this.busy) return;
    let range = this.selection();
    const whole = !range;
    if (whole) { range = document.createRange(); range.selectNodeContents(c); }
    const text = (whole ? plainText(c.innerHTML) : range.toString()).trim();
    if (!text) return;
    this.busy = true;
    const label = btn?.textContent;
    if (btn) { btn.textContent = '…'; btn.disabled = true; }
    try {
      const r = await fn(text, whole ? 'mixed' : 'formula');
      if (this.editing !== t) return; // the box was closed meanwhile
      // put the result in place of the text (by hand: the browser's insertHTML adds line breaks
      // around non-editable spans and drops spaces)
      const tpl = document.createElement('template');
      tpl.innerHTML = latexToHtml(r.text || text, whole ? null : text);
      range.deleteContents();
      const last = tpl.content.lastChild;
      range.insertNode(tpl.content);
      if (last) { const after = document.createRange(); after.setStartAfter(last); after.collapse(true); this.range = after; }
      this.focus();
      fillMath(c);
      t.html = sanitize(c.innerHTML);
      this.changed();
      this.placeBar();
      if (r.note) this.o.notify(r.note);
    } catch (err) {
      this.o.notify('Convert to LaTeX failed: ' + (err.message || err));
    } finally {
      this.busy = false;
      if (btn) { btn.textContent = label; btn.disabled = false; }
    }
  }
  // double-click on typeset maths while editing: back to what was typed (or to its LaTeX)
  unconvert(m) {
    const c = this.content();
    if (!c || !c.contains(m)) return;
    const tn = document.createTextNode(m.dataset.src || m.dataset.tex);
    m.replaceWith(tn);
    const r = document.createRange();
    r.setStartAfter(tn); r.collapse(true);
    this.range = r;
    this.focus();
    this.editing.html = sanitize(c.innerHTML);
    this.changed();
  }

  // ---------------------------------------------------------------------------- move / width
  drag(e, box, what) {
    e.preventDefault(); e.stopPropagation();
    const t = this.texts.find(x => x.id === box.dataset.id);
    if (!t) return;
    const x0 = e.clientX, y0 = e.clientY, start = { x: t.x, y: t.y, w: t.w || box.offsetWidth };
    const target = e.target;
    target.setPointerCapture(e.pointerId);
    const move = ev => {
      const dx = (ev.clientX - x0) / this.s, dy = (ev.clientY - y0) / this.s;
      if (what === 'move') { t.x = Math.round(start.x + dx); t.y = Math.round(start.y + dy); }
      else t.w = Math.max(40, Math.round(start.w + dx));
      this.render(); this.placeBar();
    };
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); this.changed(); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------------------- the format bar
  buildBar() {
    const t = this.editing;
    this.bar.innerHTML = `
      <select data-tx="font" title="Font (whole box)">${Object.entries(FONTS).map(([k, [n]]) => `<option value="${k}">${n}</option>`).join('')}</select>
      <select data-tx="size" title="Font size: of the selected letters, or of the whole box">${SIZES.map(v => `<option value="${v}">${v}</option>`).join('')}</select>
      <button data-tx="smaller" title="Smaller: the selected letters, or the whole box">A−</button>
      <button data-tx="bigger" title="Bigger: the selected letters, or the whole box">A+</button>
      <button data-tx="bold" title="Bold (Ctrl+B)"><b>B</b></button>
      <button data-tx="italic" title="Italic (Ctrl+I)"><i>I</i></button>
      <span class="tx-colors">${this.o.colors().map(([k, css]) => `<button data-tx="color" data-key="${k}" data-css="${css}" class="tx-swatch" style="background:${css}" title="Colour: the selected letters, or the whole box"></button>`).join('')}</span>
      ${this.o.extras.map((x, i) => `<button data-tx="x${i}" title="${esc(x.title || '')}">${esc(x.label)}</button>`).join('')}
      <button data-tx="delete" title="Delete this text box">🗑</button>`;
    this.bar.querySelector('[data-tx=font]').value = t.font || 'sans';
    this.bar.hidden = false;
    this.syncBar();
    this.placeBar();
  }
  syncBar() {
    if (!this.editing || !this.bar || this.bar.hidden) return;
    const part = this.selection();
    let v = this.editing.size;
    if (part) v = Math.round(parseFloat(getComputedStyle(nodeOf(part)).fontSize));
    const sel = this.bar.querySelector('[data-tx=size]');
    if (![...sel.options].some(o => +o.value === v)) sel.add(new Option(v, v));
    sel.value = v;
  }
  placeBar() {
    const t = this.editing;
    if (!t || !this.bar || this.bar.hidden) return;
    const el = this.els.get(t.id);
    const h = this.bar.offsetHeight || 34;
    let top = t.y * this.s - h - 8;
    if (top < 0) top = (t.y + (el?.offsetHeight || 40)) * this.s + 8;
    const left = Math.max(0, Math.min(t.x * this.s - 22, this.W * this.s - this.bar.offsetWidth));
    Object.assign(this.bar.style, { left: left + 'px', top: top + 'px' });
  }
}
