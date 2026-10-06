// ink2latex app: groups ink into regions, transcribes them via the local server,
// shows results in the side panel, interprets whole pages, handles photos, pages, print and export.

import { Board, PAGE, renderCrop, renderRegion, renderPageImage, strokeBox, unionBox, strokePath, paintStroke } from './ink.js?v=2026-10-06.0545';
import { sameReading, readingOf } from './latexnorm.js?v=2026-10-06.0545';
import { straightenFigure, recognize } from './shapes.js?v=2026-10-06.0545';
import { initSend } from './send.js?v=2026-10-06.0545';
import { initStudent } from './student.js?v=2026-10-06.0545';
import { initAssign } from './assign.js?v=2026-10-06.0545';
import { initFullscreen } from '../fullscreen.js?v=2026-10-06.0545';
import { paneLayer, newPaneId, publicPanes, paneZoom } from '../panes.js?v=2026-10-06.0545';
import { TextLayer, plainText, sanitize, fillMath } from '../textboxes.js?v=2026-10-06.0545';
import { imageLayer, drawImages, fitInPage, compressImage, pdfToImages, blobToDataUrl, dataUrlToBlob, publicImages, newImageId } from '../figures.js?v=2026-10-06.0545';

const $ = sel => document.querySelector(sel);
const MODELS = {
  haiku: 'Haiku 4.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5',
  'mistral-small': 'Mistral Small 4', 'mistral-medium': 'Mistral Medium 3.5', 'mistral-large': 'Mistral Large 3',
  'gpt-luna': 'GPT-6 Luna', 'gpt-sol': 'GPT-6.1 Sol', 'gpt-astra': 'GPT-6 Astra',
  context: 'page context',
};
const ENGINES = { claude: 'Claude', mistral: 'Mistral', openai: 'ChatGPT' };
const engineOf = k => String(k).startsWith('mistral') ? 'mistral' : String(k).startsWith('gpt') ? 'openai' : 'claude';
const heavyName = () => MODELS[heavyModel()] || 'The AI'; // the model "= ?AI" and figures use (after the final model's engine)
const isMistral = k => engineOf(k) === 'mistral';
// figures and "= ?AI" use the heavy model of the final model's engine (with more reasoning)
const heavyModel = () => ({ mistral: 'mistral-medium', openai: 'gpt-sol', claude: 'opus' })[engineOf(settings.finalModel)];
const IDLE_MS = 900;           // pause before a region is transcribed
const THEMES = {
  // eight pen colours (the four swatches in the tool bar, four more on C): each named, so it follows the board
  white: { bg: '#ffffff', palette: { auto: '#1b1b1b', blue: '#1f5fd1', red: '#c62828', green: '#2e7d32', orange: '#e65100', purple: '#6a1b9a', teal: '#00838f', yellow: '#f9a825' } },
  black: { bg: '#1f2b26', palette: { auto: '#f2f1e8', blue: '#7fb2ff', red: '#ff8a80', green: '#9ae6a0', orange: '#ffb74d', purple: '#ce93d8', teal: '#80deea', yellow: '#fff176' } },
};

// ----------------------------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } },
};

// The session itself is kept in IndexedDB: no 5 MB limit and no big JSON string to build.
const idb = (() => {
  let dbp = null;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('ink2latex', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  return {
    get: k => open().then(db => new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    })),
    set: (k, v) => open().then(db => new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    })),
  };
})();

// access token for LAN mode: taken from ?t=..., then kept for this tab
let TOKEN = new URLSearchParams(location.search).get('t');
try {
  if (TOKEN) sessionStorage.setItem('inkToken', TOKEN); else TOKEN = sessionStorage.getItem('inkToken');
} catch { /* ignore */ }
if (TOKEN) history.replaceState(null, '', location.pathname);

const settings = Object.assign(
  { auto: true, liveModel: 'haiku', finalModel: 'sonnet', board: 'white', snap: true, panel: true, size: 3, orientation: 'portrait',
    view: 'ink', autoInterp: true, autoAccept: false, autoEval: true, autoMerge: true,
    // robust reading: region shown in its page at true scale; whole lines grouped; two live readings
    // (a third, final-model reading when they differ); an independent page reading on Interpret page.
    // twoReadings + pageCheck are what the Fast / Balanced / Careful selector sets; Balanced to start.
    readContext: true, lineGroup: true, twoReadings: true, pageCheck: false, cardFilter: 'all' },
  store.get('ink2latex.settings', {}),
);
const saveSettings = () => store.set('ink2latex.settings', settings);
let previewHeld = false; // Preview held down (setPreview); read by renderTypeset

// ----------------------------------------------------------------------------------- state
const newPage = () => ({ uid: crypto.randomUUID(), strokes: [], undo: [], redo: [], blocks: [], interp: null, texts: [], images: [], panes: [] });
const state = { pages: [newPage()], cur: 0, photos: [], cost: 0, calls: 0, costBy: {} };
let send = null; // send mode (send.js), set up at the end
let student = null; // student mode (student.js): set when the board was opened with ?join=CODE
let assign = null; // assignments (assign.js)
let blockSeq = 0, photoSeq = 0;
const curPage = () => state.pages[state.cur];

// Region layout (boxes of all regions and their parts) is computed once per change and reused, e.g.
// by the hover check that runs while the pen hovers between strokes.
let layoutVer = 0, layoutCache = null;
function layoutOf(page = curPage()) {
  if (layoutCache && layoutCache.ver === layoutVer && layoutCache.page === page) return layoutCache.list;
  const list = sortedBlocks(page).map(o => ({ ...o, parts: partsOf(o.b, page) }));
  layoutCache = { ver: layoutVer, page, list };
  return list;
}

const board = new Board($('#board'), {
  onCommit: () => { $('#hint').hidden = true; layoutVer++; clearErrorMarks(true); scheduleRegroup(); scheduleInterpret(); saveSoon(); },
  onSnap: (type, p) => toastAt(type, p),
  onSelect: sel => placeSelBar(sel),
  onTransform: strokes => afterTransform(strokes),
});
// typed text boxes (T tool), a layer over the ink; students see them (pagePayload)
const textLayer = new TextLayer($('#sheet'), {
  onChange: () => { $('#hint').hidden = true; saveSoon(); },
  colors: () => Object.entries(THEMES[settings.board].palette),
  autoColor: () => THEMES[settings.board].palette.auto,
  defaults: () => ({ font: 'sans', size: 32, color: 'auto' }),
  notify: msg => toast(msg),
  onFinish: t => answerTextBox(t),
  extras: [{
    label: '∑ LaTeX',
    title: 'Convert to LaTeX: the selected text (one formula), or the whole box (only its maths). Typed maths such as "integral (1/(d^2+n^2)) from 0 to infinity" becomes typeset. Double-click on the maths (while editing) brings the typed text back.',
    run: (box, layer, btn) => layer.convertLatex(async (text, mode) => {
      const r = await api({ task: 'text2latex', model: settings.finalModel, expr: text, context: mode });
      return r.data;
    }, btn),
  }],
});
textLayer.setScale(board.s, board.pageW, board.pageH);
{ const setPage0 = board.setPage.bind(board); board.setPage = page => { setPage0(page); textLayer.setTexts(page.texts ||= []); renderFigHandles(); renderHiddenBadge(); }; }
// slides and figures: their own canvas under the board's canvas (see imageLayer in figures.js)
const bgCanvas = document.createElement('canvas');
bgCanvas.id = 'imageLayer';
$('#board').before(bgCanvas);
const updateImageLayer = imageLayer(bgCanvas);
// HTML panes: between the slide and the ink (lecturer: may run with full access: it is their own file)
const panes = paneLayer($('#sheet'), { sandbox: new URLSearchParams(location.search).has('join') || settings.studentLecture ? 'allow-scripts' : 'allow-scripts allow-same-origin allow-forms allow-popups', before: $('#board') });
let htmlInteract = false;
board.underlay = page => {
  const hasPanes = !!page.panes?.length;
  document.body.classList.toggle('has-panes', hasPanes);
  const btn = document.getElementById('htmlBtn');
  if (btn) btn.hidden = !hasPanes;
  if (!hasPanes && htmlInteract) setInteract(false);
  panes.update(page.panes, board.s, board.pageW, board.pageH, { interact: htmlInteract, borders: board.tool === 'lasso' });
  renderPaneChips(page);
  // snapshots are for the students only: on this board the live HTML is shown
  return updateImageLayer((page.images || []).filter(i => !i.shot), board.s, board.dpr, board.pageW, board.pageH, board.bg, () => board.request(), hasPanes) || hasPanes;
};
function setInteract(on) {
  htmlInteract = !!on;
  document.body.classList.toggle('html-interact', htmlInteract);
  document.getElementById('htmlBtn')?.classList.toggle('on', htmlInteract);
  if (htmlInteract) toast('Interact: the pen and mouse use the HTML. 🖱 again (or I, or a pen tool) to write on it.');
  else if (document.activeElement?.tagName === 'IFRAME') { document.activeElement.blur(); window.focus(); } // keys back to the board
  board.request();
  fullscreen?.sync();
}
board.onResize = () => { const l = layoutOf(); renderFrames(l); renderTypeset(l); renderAnswers(l); placeSelBar(board.sel); textLayer.setScale(board.s, board.pageW, board.pageH); renderFigHandles(); };

// "= ?", "= ?N", "= ?S", "= ?AI" typed in a text box (also in maths made with ∑ LaTeX): answered
// when you leave the box, with the same tasks as for handwriting; the answer replaces the "?"
const textAsking = new Set();
async function answerTextBox(t) {
  for (const q of textLayer.questions(t)) {
    const key = t.id + '|' + q.expr;
    if (textAsking.has(key)) continue;
    textAsking.add(key);
    toast(q.mode === 'ai' ? 'The AI is working it out…' : 'Calculating…');
    try {
      const page = curPage();
      const context = [
        contextFor(null, page),
        ...(page.texts || []).map(x => `- ${x === t ? 'this' : 'other'} text box: ${plainText(x.html).replace(/\s+/g, ' ').slice(0, 400)}`),
      ].filter(Boolean).join('\n');
      const body = q.mode === 'ai'
        ? { task: 'solve', model: heavyModel(), expr: q.expr, context }
        : { task: 'evaluate', model: settings.finalModel, expr: q.expr, context, force: { num: 'numeric', sym: 'symbolic' }[q.mode] };
      const r = await api(body);
      const v = answerValue({ answer: { status: 'ok', mode: q.mode, data: r.data, explicit: true } });
      if (!v?.latex) { toast(v?.label || 'No answer'); continue; }
      if (!textLayer.placeAnswer(t, q.expr, v)) toast('The question was changed meanwhile: leave the box again to ask it');
    } catch (err) {
      toast('Calculation failed: ' + (err.message || err));
    } finally {
      textAsking.delete(key);
    }
  }
}

// ----------------------------------------------------------------------------------- slides and figures
// Import slides (PDF): each PDF page becomes a page with the slide as background (page.images, bg).
// Insert figure: an image on this page, under the ink; Select tool shows handles to move, resize,
// delete. Images go to Supabase Storage when signed in (📡 Send); otherwise they stay in the session
// as data and are uploaded before sending.
const pageIsEmpty = p => !p.strokes.length && !(p.texts || []).length && !(p.images || []).length && !(p.panes || []).length;
// to Supabase Storage (a web address), or null when not signed in or the upload fails. A failure is
// shown (once per reason): slides only on this PC are never sent, so students would not see them.
let uploadWarned = '';
const upload = async blob => {
  try { return send ? await send.uploadImage(blob) : null; } catch (err) {
    const msg = err.message || String(err);
    if (msg !== uploadWarned) { uploadWarned = msg; toast(`Slides/figures could not be uploaded, so students do not see them: ${msg}`); }
    return null;
  }
};
async function storeImage(blob) {
  return (await upload(blob)) || blobToDataUrl(blob);
}
async function uploadPendingImages() {
  let changed = false, left = 0;
  for (const p of state.pages) for (const im of p.images || []) {
    if (!im.src.startsWith('data:')) continue;
    const url = await upload(await dataUrlToBlob(im.src));
    if (url) { im.src = url; changed = true; } else left++;
  }
  for (const p of state.pages) for (const pn of p.panes || []) {
    if (typeof pn.html !== 'string' || pn.src) continue;
    const url = await send?.uploadText(pn.html).catch(() => null);
    if (url) { pn.src = url; delete pn.html; changed = true; } else left++;
  }
  await snapshotPanes(curPage()).catch(() => {});
  if (changed) saveSoon();
  if (left && send?.isLive()) toast(`${left} slide${left > 1 ? 's' : ''}/figure${left > 1 ? 's' : ''} only on this PC (sign in under 📡 Send): students do not see ${left > 1 ? 'them' : 'it'} yet`);
}
function setOrientation(o) {
  settings.orientation = o; saveSettings();
  $('#orientation').value = o;
  board.setPageSize(o);
}
async function importSlides(file) {
  toast('Reading the slides…');
  let imgs;
  try { imgs = await pdfToImages(file, { onProgress: (i, n) => toast(`Slide ${i} of ${n}…`) }); }
  catch (err) { toast('Could not read this PDF: ' + (err.message || err)); return; }
  if (!imgs.length) return;
  // the page format of the slides, if nothing has been written yet (else they are fitted in)
  const a = imgs[0].w / imgs[0].h, fmt = a > 1.6 ? 'wide' : a > 1.2 ? 'landscape' : 'portrait';
  if (fmt !== settings.orientation && state.pages.every(pageIsEmpty)) setOrientation(fmt);
  const reuse = pageIsEmpty(curPage());
  let at = state.cur;
  const first = reuse ? state.cur : state.cur + 1;
  for (const [i, im] of imgs.entries()) {
    let page;
    if (reuse && i === 0) page = curPage();
    else { page = newPage(); state.pages.splice(++at, 0, page); }
    page.images = [...(page.images || []).filter(x => !x.bg),
      { id: newImageId(), src: await storeImage(im.blob), ...fitInPage(im.w, im.h, board.pageW, board.pageH), bg: true }];
    toast(`Slide ${i + 1} of ${imgs.length} stored`);
  }
  gotoPage(first);
  saveSoon();
  toast(`${imgs.length} slide${imgs.length > 1 ? 's' : ''} imported. Write on them as on any page.`);
}
async function insertFigure(file) {
  try {
    const { blob, w, h } = await compressImage(file, 1600);
    const src = await storeImage(blob);
    const W = board.pageW, H = board.pageH;
    const fw = Math.min(W * 0.5, w), fh = fw * h / w;
    (curPage().images ||= []).push({ id: newImageId(), src, x: (W - fw) / 2, y: Math.max(40, (H - fh) / 3), w: fw, h: fh, bg: false });
    $('#hint').hidden = true;
    board.request(); saveSoon(); renderFigHandles();
    toast('Figure added. Select tool (S): move, resize or delete it.');
  } catch (err) {
    toast('Could not add this image: ' + (err.message || err));
  }
}
// handles in Select mode: ✥ move, ◢ resize (keeps the shape), ✕ delete (a slide: only delete)
function renderFigHandles() {
  let layer = $('#figLayer');
  if (!layer) { layer = document.createElement('div'); layer.id = 'figLayer'; $('#sheet').appendChild(layer); }
  const page = curPage(), s = board.s;
  const imgs = (page.images || []).filter(i => !i.shot && !i.lock), pns = page.panes || [];
  if (board.tool !== 'lasso' || !(imgs.length + pns.length)) { layer.innerHTML = ''; return; }
  const box = (o, kind, inner) => `<div class="fig-box${o.bg ? ' bg' : ''}${kind === 'pane' ? ' pane' : ''}" data-id="${o.id}" data-kind="${kind}" style="left:${o.x * s}px;top:${o.y * s}px;width:${o.w * s}px;height:${o.h * s}px">${inner}</div>`;
  layer.innerHTML = imgs.map(im => box(im, 'img', `
    ${im.bg ? '' : '<button class="fig-h move" data-h="move" title="Drag to move the figure">✥</button><button class="fig-h size" data-h="size" title="Drag to resize">◢</button>'}
    <button class="fig-h del" data-h="del" title="${im.bg ? 'Remove the slide from this page' : 'Delete the figure'}">✕</button>`)).join('')
    + pns.map(p => box(p, 'pane', `
    <button class="fig-h move" data-h="move" title="Drag to move the HTML">✥</button>
    <button class="fig-h mode${p.mode === 'snapshot' ? ' snap' : ''}" data-h="mode" title="What students get. Click to switch: their own copy of the HTML to use, or a picture of yours, taken whenever you write on it">${p.mode === 'snapshot' ? '📷 students: snapshot' : '👥 students: own copy'}</button>
    <button class="fig-h size" data-h="size" title="Drag to resize">◢</button>
    <button class="fig-h border" data-h="border" title="Border: ${p.border === 'none' ? 'transparent (click: visible)' : 'visible (click: transparent)'}. It always shows near the top-left corner and in Select mode.">${p.border === 'none' ? '▢' : '■'}</button>
    <button class="fig-h del" data-h="del" title="Delete the HTML">✕</button>`)).join('');
}
document.addEventListener('pointerdown', e => {
  const h = e.target.closest?.('#figLayer .fig-h');
  if (!h) return;
  e.preventDefault(); e.stopPropagation();
  const page = curPage(), fb = h.closest('.fig-box'), id = fb.dataset.id, pane = fb.dataset.kind === 'pane';
  const list = pane ? (page.panes ||= []) : page.images, im = list.find(x => x.id === id);
  if (!im) return;
  const done = () => { board.request(); saveSoon(); renderFigHandles(); };
  if (h.dataset.h === 'del') {
    if (pane) { page.panes = page.panes.filter(x => x !== im); page.images = page.images.filter(x => x.id !== 'shot-' + im.id); }
    else page.images = page.images.filter(x => x !== im);
    done(); return;
  }
  if (h.dataset.h === 'border') { im.border = im.border === 'none' ? 'visible' : 'none'; done(); return; }
  if (h.dataset.h === 'mode') {
    im.mode = im.mode === 'snapshot' ? 'own' : 'snapshot';
    if (im.mode === 'own') page.images = page.images.filter(x => x.id !== 'shot-' + im.id); else im.shotKey = '';
    toast(im.mode === 'snapshot' ? 'Students get a picture of this HTML, taken whenever you write on it (while sending)' : 'Students get their own copy of this HTML to use');
    done(); return;
  }
  const x0 = e.clientX, y0 = e.clientY, start = { ...im }, s = board.s, box = h.closest('.fig-box');
  h.setPointerCapture(e.pointerId);
  const move = ev => {
    const dx = (ev.clientX - x0) / s, dy = (ev.clientY - y0) / s;
    if (h.dataset.h === 'move') { im.x = start.x + dx; im.y = start.y + dy; }
    else if (pane) { im.w = Math.max(80, start.w + dx); im.h = Math.max(60, start.h + dy); } // HTML: any shape
    else { im.w = Math.max(40, start.w + dx); im.h = im.w * start.h / start.w; }
    // move the frame itself (re-building the handles would lose the pointer)
    Object.assign(box.style, { left: im.x * s + 'px', top: im.y * s + 'px', width: im.w * s + 'px', height: im.h * s + 'px' });
    board.request();
  };
  const up = () => { h.removeEventListener('pointermove', move); saveSoon(); renderFigHandles(); };
  h.addEventListener('pointermove', move);
  h.addEventListener('pointerup', up, { once: true });
  h.addEventListener('pointercancel', up, { once: true });
}, true);
{
  const menu = $('#figMenu');
  $('#figBtn').addEventListener('click', e => { e.stopPropagation(); menu.hidden = !menu.hidden; keepOnScreen(menu); });
  menu.addEventListener('click', e => {
    e.stopPropagation();
    const b = e.target.closest('[data-fig]');
    if (!b) return;
    menu.hidden = true;
    if (b.dataset.fig === 'clear') { openClearDialog(); return; }
    $({ slides: '#pdfInput', figure: '#figInput', html: '#htmlInput' }[b.dataset.fig]).click();
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  $('#pdfInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importSlides(f); });
  $('#figInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertFigure(f); });
  $('#htmlInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertHtml(f); });
}

// About: the DEX logo in the tool bar opens it. Closes with the button, Esc or a click outside.
function openAboutDialog() {
  $('#aboutDlg')?.remove();
  const ver = new URL(import.meta.url).searchParams.get('v') || 'dev';
  const d = document.createElement('div');
  d.id = 'aboutDlg';
  d.innerHTML = `<div class="about-box" role="dialog" aria-label="About ink2latex">
      <img src="dex-logo.png" alt="DEX: Digital Experiments">
      <strong>ink2latex</strong>
      <div class="dim">An interactive digital whiteboard</div>
      <p>Developed by Peter Bøggild (DTU) using Claude (Anthropic), to support teaching, interaction and
        AI-supported coaching and transcription, based on advanced multimodal input with digital pens.</p>
      <p><a href="https://dex-2dphys.github.io/" target="_blank" rel="noopener">DEX: Digital Experiments ↗</a></p>
      <p class="dim">Press K for the keyboard shortcuts.</p>
      <div class="about-act"><span class="dim">Version ${ver}</span><button data-a="close">Close</button></div>
    </div>`;
  document.body.appendChild(d);
  const close = () => { d.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  d.addEventListener('pointerdown', e => { if (e.target === d) close(); });
  d.querySelector('[data-a="close"]').addEventListener('click', close);
}

// Clear…: slides and figures, writing (ink and text boxes), or both; on this page or on all pages.
// With "all pages", pages left with nothing on them are removed (e.g. after importing twice).
// Ink cleared on this page can be brought back with Ctrl+Z; the rest cannot.
function openClearDialog() {
  $('#clearDlg')?.remove();
  const d = document.createElement('div');
  d.id = 'clearDlg';
  d.innerHTML = `<div class="clear-box">
      <strong>Clear</strong>
      <label><input type="checkbox" data-c="images" checked> Slides and figures</label>
      <label><input type="checkbox" data-c="writing"> Writing (ink and text boxes)</label>
      <hr>
      <label><input type="radio" name="clearWhere" value="page" checked> This page</label>
      <label><input type="radio" name="clearWhere" value="all"> All pages <span class="dim">(pages left empty are removed)</span></label>
      <div class="clear-act"><button data-c="cancel">Cancel</button><button data-c="go" class="danger">Clear</button></div>
      <hr>
      <div class="clear-pages">
        <button data-c="delpage" title="Remove the page you are on, with everything on it">Delete this page</button>
        <button data-c="restart" class="danger" title="Delete all pages and start with one empty page">Start over: delete all pages</button>
      </div>
    </div>`;
  document.body.appendChild(d);
  d.addEventListener('pointerdown', e => { if (e.target === d) d.remove(); });
  d.addEventListener('click', e => {
    const b = e.target.closest('button[data-c]');
    if (!b) return;
    if (b.dataset.c === 'cancel') { d.remove(); return; }
    if (b.dataset.c === 'delpage') { d.remove(); deletePages(false); return; }
    if (b.dataset.c === 'restart') {
      if (!confirm(`Delete all ${state.pages.length} pages and start with one empty page? This cannot be undone.`)) return;
      d.remove(); deletePages(true); return;
    }
    const images = d.querySelector('[data-c=images]').checked, writing = d.querySelector('[data-c=writing]').checked;
    const all = d.querySelector('[name=clearWhere]:checked').value === 'all';
    d.remove();
    if (images || writing) clearPages({ images, writing, all });
  });
}
// Delete this page (all = false) or all pages (start over with one empty page)
function deletePages(all) {
  if (all || state.pages.length === 1) {
    state.pages.splice(0, state.pages.length, newPage());
    state.cur = 0;
  } else {
    state.pages.splice(state.cur, 1);
    state.cur = Math.min(state.cur, state.pages.length - 1);
  }
  gotoPage(state.cur);
  board.request(); renderAll(); renderFigHandles(); saveSoon();
  toast(all ? 'All pages deleted: a fresh board' : `Page deleted (${state.pages.length} left)`);
}
function clearPages({ images, writing, all }) {
  const targets = all ? state.pages : [curPage()];
  for (const p of targets) {
    if (images) { p.images = (p.images || []).filter(i => i.lock); p.panes = []; } // locked: an assignment's task, a hand-in
    if (writing) {
      if (p === curPage()) board.clear(); // undoable with Ctrl+Z
      else { p.strokes = []; p.undo = []; p.redo = []; }
      p.blocks = []; p.interp = null; p.texts = [];
    }
  }
  let removed = 0;
  if (all) {
    const kept = state.pages.filter(p => !pageIsEmpty(p));
    removed = state.pages.length - Math.max(1, kept.length);
    state.pages.splice(0, state.pages.length, ...(kept.length ? kept : [state.pages[0]]));
    state.cur = Math.min(state.cur, state.pages.length - 1); // the page shown may have been removed
    gotoPage(state.cur);
  } else {
    textLayer.setTexts(curPage().texts);
  }
  board.request(); renderAll(); renderFigHandles(); saveSoon();
  toast(`Cleared${removed ? `; ${removed} empty page${removed > 1 ? 's' : ''} removed` : ''}`);
}

// ----------------------------------------------------------------------------------- HTML panes
// Insert HTML: a single-file, self-contained HTML page on this page, between the slide and the ink.
// 🖱 Interact (or I) hands the pen and mouse to it; a pen tool or 🖱 again writes on it. Select (S):
// move, resize, border, delete, and what students get: their own copy to use (sandboxed in their
// app), or a snapshot of this one, taken whenever you write on the page (while sending).
const HTML_MAX = 2 * 1024 * 1024;
async function insertHtml(file) {
  const text = await file.text();
  if (text.length > HTML_MAX) { toast('This HTML is larger than 2 MB: only lightweight, self-contained HTML can be used.'); return; }
  if (/<script[^>]+src=["'](?!https?:|data:)/i.test(text) || /<link[^>]+href=["'](?!https?:|data:|#)[^"']+\.css/i.test(text)) {
    toast('Note: this HTML refers to other files next to it; only what is inside the one file (or on the web) will work.');
  }
  const url = send ? await send.uploadText(text).catch(() => null) : null;
  const W = board.pageW, H = board.pageH, w = Math.round(W * 0.6), h = Math.round(Math.min(H * 0.6, w * 0.62));
  const p = { id: newPaneId(), name: file.name, x: Math.round((W - w) / 2), y: Math.round(H * 0.2), w, h, border: 'visible', mode: 'own' };
  if (url) p.src = url; else p.html = text;
  (curPage().panes ||= []).push(p);
  $('#hint').hidden = true;
  board.request(); saveSoon(); renderFigHandles();
  toast(`${file.name} added. 🖱 Interact (or I) to use it; Select (S) to move or resize it and choose what students get.`);
}
$('#htmlBtn').addEventListener('click', () => setInteract(!htmlInteract));
// the switch where the HTML is: a small button just above each pane's top-left corner (outside it,
// so it never covers the HTML's own controls; inside only when the pane touches the top of the page)
function renderPaneChips(page) {
  let layer = document.getElementById('paneChips');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'paneChips';
    $('#sheet').appendChild(layer);
    layer.addEventListener('pointerdown', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      if (b.dataset.z) {
        // zoom of this pane's content (like browser zoom); saved and sent with the pane
        const p = curPage().panes?.find(q => q.id === b.closest('.pane-bar').dataset.id);
        if (!p) return;
        const z = paneZoom(p), steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
        p.zoom = b.dataset.z === 'reset' ? 1 : b.dataset.z === 'in' ? (steps.find(v => v > z + 0.001) || 4) : ([...steps].reverse().find(v => v < z - 0.001) || 0.25);
        p.shotKey = '';
        board.request(); saveSoon();
        return;
      }
      setInteract(!htmlInteract);
    });
  }
  const s = board.s;
  layer.innerHTML = (page.panes || []).map(p => `<div class="pane-bar" data-id="${p.id}" style="left:${p.x * s}px;top:${p.y * s >= 34 ? p.y * s - 32 : p.y * s + 4}px">
    <button class="pane-chip${htmlInteract ? ' on' : ''}" title="${htmlInteract ? 'Back to writing on the page (or pick a pen tool)' : 'Use the HTML: click, drag, type in it (I)'}">${htmlInteract ? '✎ Write' : '🖱 Use'}</button>
    <button class="pane-z" data-z="out" title="Smaller content in this HTML">−</button>
    <button class="pane-z pct" data-z="reset" title="Content size of this HTML; click for 100 %">${Math.round(paneZoom(p) * 100)} %</button>
    <button class="pane-z" data-z="in" title="Larger content in this HTML">＋</button></div>`).join('');
}
// a border shows when the pointer comes near a pane's top-left corner (borders can be transparent)
$('#boardWrap').addEventListener('pointermove', e => {
  const pns = curPage().panes;
  if (!pns?.length) return;
  const r = $('#sheet').getBoundingClientRect(), s = board.s, x = (e.clientX - r.left) / s, y = (e.clientY - r.top) / s, near = 48 / s;
  const p = pns.find(q => Math.abs(x - q.x) < near && Math.abs(y - q.y) < near);
  panes.peek(p ? p.id : null);
});

// snapshots for students (panes set to "snapshot"): taken when the page has changed, before sending
let html2canvasP = null;
async function snapshotPane(p) {
  const fr = panes.frame(p.id), doc = fr?.contentDocument;
  if (!doc?.body) return null;
  const out = document.createElement('canvas');
  const k = Math.min(2, 1600 / p.w), z = paneZoom(p), kz = k * z; // iframe pixels -> snapshot pixels
  out.width = Math.round(p.w * k); out.height = Math.round(p.h * k);
  const g = out.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
  // a canvas filling most of the HTML (simulations): copy it
  const cv = [...doc.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  if (cv && cv.clientWidth * cv.clientHeight > 0.4 * p.w * p.h) {
    try {
      const rr = cv.getBoundingClientRect();
      g.drawImage(cv, rr.left * kz, rr.top * kz, rr.width * kz, rr.height * kz);
      const d = g.getImageData(0, 0, out.width, out.height).data;
      let varied = false;
      for (let i = 4; i < d.length; i += 4 * 97) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) { varied = true; break; }
      if (varied) return out;
    } catch { /* fall back below */ }
  }
  // otherwise: draw the page itself (approximate for complex CSS)
  html2canvasP ||= new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'; sc.onload = () => res(window.html2canvas); sc.onerror = rej; document.head.appendChild(sc); });
  try {
    const h2c = await html2canvasP;
    const c = await h2c(doc.documentElement, { backgroundColor: '#ffffff', scale: kz, width: p.w / z, height: p.h / z, windowWidth: p.w / z, windowHeight: p.h / z, logging: false });
    g.drawImage(c, 0, 0, out.width, out.height);
    return out;
  } catch { return null; }
}
async function snapshotPanes(page) {
  for (const p of page.panes || []) {
    if (p.mode !== 'snapshot') continue;
    const key = `${page.strokes.length}:${(page.texts || []).length}:${p.x},${p.y},${p.w},${p.h},${paneZoom(p)}:${page.strokes.at(-1)?.id || 0}`;
    if (p.shotKey === key || !send) continue;
    const c = await snapshotPane(p);
    if (!c) continue;
    const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.85));
    const url = blob && await send.uploadImage(blob).catch(() => null);
    if (!url) continue;
    page.images = [...(page.images || []).filter(x => x.id !== 'shot-' + p.id), { id: 'shot-' + p.id, src: url, x: p.x, y: p.y, w: p.w, h: p.h, bg: false, shot: true }];
    p.shotKey = key;
  }
}

// ----------------------------------------------------------------------------------- page overview
// ▦ Pages (or a click on "3 / 13"): thumbnails of all pages. Tap = go there; drag = move; 👁 = hide
// from students (a hidden page is not sent, students' page numbers skip it); ⧉ = duplicate; + = new
// page after it; ✕ = delete. Arrow keys / Page Up-Down change pages (presenter clickers too).

// students' page number of the page at index i (a hidden page: the visible one before it), and back
function sentIndex(i) {
  let n = -1;
  for (let k = 0; k <= Math.min(i, state.pages.length - 1); k++) if (!state.pages[k].hidden) n++;
  return Math.max(0, n);
}
function realIndex(n) {
  let c = -1;
  for (let k = 0; k < state.pages.length; k++) if (!state.pages[k].hidden && ++c === n) return k;
  return -1;
}
function renderHiddenBadge() {
  let b = $('#hiddenBadge');
  if (!b) { b = document.createElement('div'); b.id = 'hiddenBadge'; b.textContent = 'Hidden from students'; $('#sheet').appendChild(b); }
  b.hidden = !curPage().hidden;
}

function thumbOf(p, width, onLoad) {
  const W = board.pageW, H = board.pageH, k = width / W, dpr = window.devicePixelRatio || 1;
  const c = document.createElement('canvas');
  c.width = Math.round(width * dpr); c.height = Math.round(H * k * dpr);
  const g = c.getContext('2d');
  g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
  const th = THEMES[settings.board];
  g.fillStyle = th.bg;
  g.fillRect(0, 0, W, H);
  drawImages(g, (p.images || []).filter(i => !i.shot), onLoad);
  for (const pn of p.panes || []) { // an HTML pane: a framed placeholder
    g.fillStyle = '#eef2fb'; g.fillRect(pn.x, pn.y, pn.w, pn.h);
    g.strokeStyle = '#1f5fd1'; g.lineWidth = 4; g.strokeRect(pn.x, pn.y, pn.w, pn.h);
    g.fillStyle = '#1f5fd1'; g.font = `bold ${Math.max(28, pn.h / 6)}px system-ui, sans-serif`; g.fillText('HTML', pn.x + 16, pn.y + Math.max(40, pn.h / 5));
  }
  for (const s of p.strokes) paintStroke(g, s, th.palette[s.color] || s.color || th.palette.auto);
  return c;
}

function copyPage(p) {
  const id = () => newImageId();
  const q = JSON.parse(JSON.stringify({ strokes: p.strokes, blocks: p.blocks.map(b => ({ ...b, status: b.status === 'busy' ? 'stale' : b.status })), texts: p.texts || [], images: (p.images || []).filter(i => !i.shot), panes: p.panes || [], interp: p.interp }, (k, v) => (k.startsWith('_') ? undefined : v))); // no drawing caches (_path …): they do not survive a copy
  return { ...newPage(), ...q, blocks: q.blocks.map(b => ({ ...newBlock(), ...b, id: ++blockSeq })),
    texts: q.texts.map(t => ({ ...t, id: 't' + id() })), images: q.images.map(im => ({ ...im, id: id() })),
    panes: q.panes.map(pn => ({ ...pn, id: newPaneId(), shotKey: '' })), hidden: !!p.hidden };
}

function openPages() {
  closePages();
  const v = document.createElement('div');
  v.id = 'pagesView';
  v.innerHTML = `<div class="pv-box"><div class="pv-head"><strong>Pages</strong>
    <span class="dim">Tap a page to go there · drag to move · 👁 hide from students · ⧉ duplicate · + new page after · ✕ delete</span>
    <button data-pv="close" title="Close (Esc)">✕</button></div><div class="pv-grid"></div></div>`;
  document.body.appendChild(v);
  v.addEventListener('pointerdown', e => { if (e.target === v) closePages(); });
  renderPages();
}
function closePages() { $('#pagesView')?.remove(); }
let pvRedraw = 0;
function renderPages() {
  const v = $('#pagesView');
  if (!v) return;
  const grid = v.querySelector('.pv-grid');
  grid.innerHTML = '';
  const onLoad = () => { clearTimeout(pvRedraw); pvRedraw = setTimeout(renderPages, 150); };
  state.pages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'pv-tile' + (i === state.cur ? ' cur' : '') + (p.hidden ? ' hid' : '');
    t.dataset.i = i;
    t.appendChild(thumbOf(p, 220, onLoad));
    t.insertAdjacentHTML('beforeend', `<span class="pv-num">${i + 1}</span>${p.hidden ? '<span class="pv-hidden-tag">hidden from students</span>' : ''}
      <div class="pv-act">
        <button data-pv="hide" class="${p.hidden ? 'on' : ''}" title="${p.hidden ? 'Show to students again' : 'Hide from students (not sent)'}">👁</button>
        <button data-pv="dup" title="Duplicate this page">⧉</button>
        <button data-pv="add" title="New empty page after this one">+</button>
        <button data-pv="del" title="Delete this page">✕</button>
      </div>`);
    grid.appendChild(t);
  });
  grid.insertAdjacentHTML('beforeend', '<button class="pv-new" data-pv="new">+ New page</button>');
}
// keep showing the page that was on screen, wherever it moved; tell the students
function pagesChanged(curObj) {
  const i = state.pages.indexOf(curObj);
  state.cur = i >= 0 ? i : Math.min(state.cur, state.pages.length - 1);
  gotoPage(state.cur);
  renderHiddenBadge();
  saveSoon();
  renderPages();
}
document.addEventListener('click', e => {
  const b = e.target.closest?.('#pagesView [data-pv]');
  if (!b) return;
  e.stopPropagation();
  const a = b.dataset.pv, tile = b.closest('.pv-tile'), i = tile ? +tile.dataset.i : -1, curObj = curPage();
  if (a === 'close') { closePages(); return; }
  if (a === 'new') { state.pages.push(newPage()); pagesChanged(curObj); return; }
  const p = state.pages[i];
  if (a === 'hide') { p.hidden = !p.hidden; pagesChanged(curObj); return; }
  if (a === 'dup') { state.pages.splice(i + 1, 0, copyPage(p)); pagesChanged(curObj); toast(`Page ${i + 1} duplicated`); return; }
  if (a === 'add') { state.pages.splice(i + 1, 0, newPage()); pagesChanged(curObj); return; }
  if (a === 'del') {
    if ((p.strokes.length || p.texts?.length) && !confirm(`Delete page ${i + 1} with its writing?`)) return;
    state.pages.splice(i, 1);
    if (!state.pages.length) state.pages.push(newPage());
    pagesChanged(curObj);
  }
}, true);
// tap = go to the page; drag = move it (pointer events: mouse, pen and finger alike)
document.addEventListener('pointerdown', e => {
  const tile = e.target.closest?.('#pagesView .pv-tile');
  if (!tile || e.target.closest('button')) return;
  e.preventDefault();
  const from = +tile.dataset.i, x0 = e.clientX, y0 = e.clientY;
  let dragging = false, target = from;
  const tiles = () => [...document.querySelectorAll('#pagesView .pv-tile')];
  const move = ev => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) return;
    dragging = true;
    tile.classList.add('dragging');
    // the tile whose centre is nearest decides the place (before it)
    let best = null, bd = Infinity;
    for (const t of tiles()) {
      const r = t.getBoundingClientRect(), d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
      if (d < bd) { bd = d; best = t; }
    }
    tiles().forEach(t => t.classList.remove('drop-before'));
    if (best) {
      const r = best.getBoundingClientRect(), bi = +best.dataset.i;
      target = ev.clientX > r.left + r.width / 2 ? bi + 1 : bi;
      const mark = tiles()[target];
      if (mark && mark !== tile) mark.classList.add('drop-before');
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!dragging) { gotoPage(from); renderHiddenBadge(); closePages(); return; }
    const curObj = curPage(), [p] = state.pages.splice(from, 1);
    state.pages.splice(target > from ? target - 1 : target, 0, p);
    pagesChanged(curObj);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}, true);
$('#pagesBtn').addEventListener('click', openPages);

// full screen: the page alone, essential tools in a floating bar at the left (viewer/fullscreen.js)
const fullscreen = initFullscreen({
  toolbar: $('#toolbar'),
  hide: [$('#panel'), $('#panelResizer')],
  menuOpen: () => !$('#settingsMenu').hidden || !$('#sendMenu').hidden || !$('#viewMenu').hidden || !$('#figMenu').hidden,
  tools: [
    { icon: '＋', tip: 'Zoom in (Ctrl + wheel)', run: () => board.setZoom(board.zoom * 1.2) },
    { icon: '−', tip: 'Zoom out (Ctrl + wheel)', run: () => board.setZoom(board.zoom / 1.2) },
    { icon: '⤢', tip: 'Fit the page to the width', run: () => board.setZoom(1) },
    null,
    { icon: '✎', tip: 'Pen (P)', run: () => setTool('pen'), on: () => board.tool === 'pen' },
    { icon: '🔴', tip: 'Laser pointer (P or Shift)', run: () => setTool('laser'), on: () => board.tool === 'laser' },
    { icon: '⌫', tip: 'Eraser (E)', run: () => setTool('eraser'), on: () => board.tool === 'eraser' },
    { icon: '◌', tip: 'Select (S)', run: () => setTool('lasso'), on: () => board.tool === 'lasso' },
    { icon: 'T', tip: 'Text (T)', run: () => setTool('text'), on: () => board.tool === 'text' },
    { icon: '🖱', tip: 'Use the HTML on this page / write on it (I)', run: () => curPage().panes?.length ? setInteract(!htmlInteract) : toast('No HTML on this page'), on: () => htmlInteract },
    null,
    { icon: '↶', tip: 'Undo (Ctrl+Z)', run: () => board.undo() },
    { icon: '↷', tip: 'Redo (Ctrl+Y)', run: () => board.redo() },
    null,
    { icon: '◀', tip: 'Previous page (←)', run: () => state.cur > 0 && gotoPage(state.cur - 1) },
    { icon: '▶', tip: 'Next page (→)', run: () => state.cur < state.pages.length - 1 && gotoPage(state.cur + 1) },
  ],
});
$('#fsBtn').addEventListener('click', () => fullscreen.toggle());
$('#aboutBtn').addEventListener('click', openAboutDialog);
// no long-press menu on the board (tablets), except in a text box being typed in
$('#boardWrap').addEventListener('contextmenu', e => { if (!e.target.closest('.tx-box.editing')) e.preventDefault(); });
$('#pageLabel').addEventListener('click', openPages);

// ----------------------------------------------------------------------------------- grouping
let regroupTimer = 0;
function scheduleRegroup() {
  clearTimeout(regroupTimer);
  regroupTimer = setTimeout(regroup, IDLE_MS);
}

function near(a, b, mx, my) {
  return a.x0 - mx <= b.x1 && b.x0 - mx <= a.x1 && a.y0 - my <= b.y1 && b.y0 - my <= a.y1;
}

// Lines, not fragments: two pieces of ink on the same written line (their boxes overlap vertically
// by at least half the smaller height) belong together across a wider horizontal gap than ink on
// different lines, so "F = ma" written with generous spaces is read as one expression, not three.
// Ink on separate lines still needs the ordinary nearness (a derivation's lines stay one region
// only when they are close, as before).
const lineReach = h => clamp(2.6 * h, 50, 160);
function sameLine(a, b) {
  const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return ov > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
}
function joinable(a, b, mx, my, h) {
  if (near(a, b, mx, my)) return true;
  return !!settings.lineGroup && sameLine(a, b) && near(a, b, Math.max(mx, lineReach(h)), 0);
}

function typicalHeight(strokes) {
  const h = strokes.filter(s => !s.shape).map(s => { const b = strokeBox(s); return b.y1 - b.y0; }).sort((a, b) => a - b);
  return h.length ? h[Math.floor(h.length / 2)] : 30;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function strokesOf(block, page = curPage()) {
  const ids = new Set(block.strokeIds);
  return page.strokes.filter(s => ids.has(s.id));
}
function blockBox(block, page = curPage()) {
  const st = strokesOf(block, page);
  return st.length ? unionBox(st.map(strokeBox)) : null;
}
const sigOf = ids => ids.slice().sort((x, y) => x - y).join(',');

// New strokes join a nearby region (merging regions they bridge) or start a new one.
// Strokes written in one go (between two pauses) hold together more loosely than separate bursts.
// Regions whose set of strokes changed are re-transcribed.
function regroup() {
  if (board.active) { scheduleRegroup(); return; }
  const page = curPage();
  const byId = new Map(page.strokes.map(s => [s.id, s]));
  for (const b of page.blocks) b.strokeIds = b.strokeIds.filter(id => byId.has(id));
  page.blocks = page.blocks.filter(b => b.strokeIds.length);

  const assigned = new Set(page.blocks.flatMap(b => b.strokeIds));
  const fresh = page.strokes.filter(s => !assigned.has(s.id));
  if (fresh.length) {
    const h = typicalHeight(page.strokes);
    const mx = clamp(1.4 * h, 30, 90), my = clamp(0.65 * h, 12, 38);
    // existing regions take part with each of their parts, so writing in the gap between two parts
    // of a spread-out equation does not join it unless it is near one of the parts
    const nodes = [
      ...page.blocks.flatMap(b => partsOf(b, page).map(pt => ({ block: b, box: pt.box }))),
      ...fresh.map(s => ({ stroke: s, box: strokeBox(s) })),
    ];
    const parent = nodes.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const nb = nodes.length - fresh.length;
    for (let i = nb; i < nodes.length; i++) {
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const burst = j >= nb; // both fresh: written in the same go
        // a fraction bar (long flat stroke) reaches further up and down: numerator and denominator join it
        const bar = isBar(nodes[i], h) || isBar(nodes[j], h);
        const vy = (burst ? 1.35 * my : my) * (bar ? 2.2 : 1);
        if (joinable(nodes[i].box, nodes[j].box, burst ? 1.3 * mx : mx, vy, h)) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    nodes.forEach((n, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(n);
    });
    for (const g of groups.values()) {
      const newStrokes = g.filter(n => n.stroke).map(n => n.stroke.id);
      if (!newStrokes.length) continue;
      const blocks = [...new Set(g.filter(n => n.block).map(n => n.block))];
      let target = blocks[0];
      if (!target) { target = newBlock(); page.blocks.push(target); }
      for (const other of blocks.slice(1)) absorb(page, target, other);
      addStrokes(target, newStrokes, page);
    }
  }
  refreshBlocks(page);
}

function isBar(node, h) {
  if (!node.stroke) return false;
  const w = node.box.x1 - node.box.x0, ht = node.box.y1 - node.box.y0;
  return w > 2.5 * ht && w > 1.2 * h;
}

// ----------------------------------------------------------------------------------- groups
// A group is one region (read, interpreted and answered as one equation) that remembers its
// members as "pieces", so each piece can still be moved on its own, and the group can be
// ungrouped again. A plain region is a single piece.
function piecesOf(b) {
  if (!b.pieces || b.pieces.length < 2) return [b.strokeIds.slice()];
  const own = new Set(b.strokeIds);
  const ps = b.pieces.map(p => p.filter(id => own.has(id))).filter(p => p.length);
  const inPieces = new Set(ps.flat());
  const loose = b.strokeIds.filter(id => !inPieces.has(id));
  if (loose.length) ps.push(loose);
  return ps;
}
const isGroup = b => piecesOf(b).length > 1;

// add strokes to a region; in a group each stroke joins the nearest piece
function addStrokes(b, ids, page) {
  if (isGroup(b)) {
    const byId = new Map(page.strokes.map(s => [s.id, s]));
    const ps = piecesOf(b);
    const boxes = ps.map(p => unionBox(p.map(id => strokeBox(byId.get(id)))));
    for (const id of ids) {
      const s = strokeBox(byId.get(id));
      const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
      let best = 0, dmin = Infinity;
      boxes.forEach((bx, k) => {
        const dx = Math.max(bx.x0 - cx, 0, cx - bx.x1), dy = Math.max(bx.y0 - cy, 0, cy - bx.y1);
        if (Math.hypot(dx, dy) < dmin) { dmin = Math.hypot(dx, dy); best = k; }
      });
      ps[best].push(id);
    }
    b.pieces = ps;
  }
  b.strokeIds.push(...ids);
}

// Group regions into the first one and read them again as one (final model, with page context)
function groupBlocks(page, blocks) {
  blocks = blocks.filter(Boolean);
  if (blocks.length < 2) return null;
  const target = blocks[0];
  for (const other of blocks.slice(1)) absorb(page, target, other);
  target.sig = sigOf(target.strokeIds);
  Object.assign(target, { confirmed: false, figure: null, suggest: null, answer: null, orig: null, edit: null });
  transcribe(target, settings.finalModel);
  return target;
}

function absorb(page, target, other) {
  target.pieces = [...piecesOf(target), ...piecesOf(other)];
  target.strokeIds.push(...other.strokeIds);
  if (other.comment && !target.comment) target.comment = other.comment;
  page.blocks = page.blocks.filter(b => b !== other);
  cardEls.get(other.id)?.remove();
  cardEls.delete(other.id);
}

// split a group back into its pieces; each is read on its own again. A region without remembered
// pieces (merged before groups existed) is split by how its ink lies on the page.
const canUngroup = b => partsOf(b, pageOf(b)).length > 1;
function ungroup(b) {
  const page = pageOf(b);
  const ps = isGroup(b) ? piecesOf(b) : partsOf(b, page).map(p => p.strokes.map(s => s.id));
  if (ps.length < 2) {
    toast('This region is one piece. To split it: ◌ Select, loop around part of it, then Group.');
    return;
  }
  page.blocks = page.blocks.filter(x => x !== b);
  cardEls.get(b.id)?.remove();
  cardEls.delete(b.id);
  ps.forEach((p, i) => {
    const nb = newBlock();
    nb.strokeIds = p;
    if (i === 0) nb.comment = b.comment;
    page.blocks.push(nb);
  });
  toast(`Ungrouped into ${ps.length} regions`);
  refreshBlocks(page);
}

// transcribe regions whose strokes changed
function refreshBlocks(page) {
  splitAtAnswerBoxes(page);
  for (const b of page.blocks) {
    const sig = sigOf(b.strokeIds);
    if (sig === b.sig) continue;
    b.sig = sig;
    b.confirmed = false;
    b.figure = null;
    b.suggest = null;
    // the ink changed: an old answer no longer applies (it is computed again if this is still a question)
    if (b.answer) { b.answer = null; b.ansVersion = (b.ansVersion || 0) + 1; }
    const box = blockBox(b, page);
    if (box && Math.hypot(box.x1 - box.x0, box.y1 - box.y0) < 14) {
      // a dot or a speck: not worth an API call
      Object.assign(b, { status: 'ok', result: { kind: 'empty', latex: '', text: '', uncertain: [] }, model: null, ms: 0, edit: null });
      continue;
    }
    if (settings.auto && !assign?.quiet()) transcribe(b, settings.liveModel); // not on feedback
    else b.status = 'stale';
  }
  renderAll();
  saveSoon();
}

// ----------------------------------------------------------------------------------- selection
// the group whose strokes are exactly the selection, if any
function selectedGroup(sel = board.sel) {
  if (!sel) return null;
  return curPage().blocks.find(b => canUngroup(b) && b.strokeIds.length === sel.ids.size && b.strokeIds.every(id => sel.ids.has(id))) || null;
}

function placeSelBar(sel) {
  const bar = $('#selBar');
  // the bar (Group, Delete …) belongs to Select mode; moving a block by its badge while writing shows none
  if (!sel || board.tool !== 'lasso') { bar.hidden = true; return; }
  bar.hidden = false;
  const g = selectedGroup(sel);
  bar.querySelector('[data-sel="group"]').hidden = !!g;
  bar.querySelector('[data-sel="ungroup"]').hidden = !g;
  const s = board.s;
  bar.style.left = Math.max(0, sel.box.x0 * s - 8) + 'px';
  bar.style.top = Math.max(0, sel.box.y0 * s - 44) + 'px';
}

$('#selBar').addEventListener('pointerdown', e => e.stopPropagation());
$('#selBar').addEventListener('click', e => {
  const act = e.target.closest('button')?.dataset.sel;
  if (act === 'group') { const st = board.selStrokes(); board.clearSelection(); if (st.length) groupStrokes(st); }
  if (act === 'ungroup') { const g = selectedGroup(); board.clearSelection(); if (g) ungroup(g); }
  if (act === 'delete') board.deleteSelection();
  if (act === 'close') board.clearSelection();
});

// Moving or resizing never changes what belongs together: moved strokes stay in their region
// (a region can be spread over several parts of the page) and nothing is re-transcribed.
// Use Group / Merge to change membership.
function afterTransform() {
  if (badgeDrag) { badgeDrag = null; board.clearSelection(); } // badge drags don't leave a selection behind
  renderAll();
  saveSoon();
}

// Parts of a region, each with its own box: the pieces of a group, or else spatial clusters of its
// strokes (one part for a compact region; several when parts have been moved apart). Reading order.
function partsOf(b, page = curPage()) {
  if (isGroup(b)) {
    const byId = new Map(page.strokes.map(s => [s.id, s]));
    return piecesOf(b).map(p => p.map(id => byId.get(id)).filter(Boolean)).filter(p => p.length)
      .map(p => ({ strokes: p, box: unionBox(p.map(strokeBox)) }))
      .sort((p, q) => readingOrder(p.box, q.box));
  }
  const st = strokesOf(b, page);
  if (st.length <= 1) return st.map(s => ({ strokes: [s], box: strokeBox(s) }));
  const h = typicalHeight(page.strokes);
  const mx = clamp(1.4 * h, 30, 90), my = clamp(0.65 * h, 12, 38) * 1.35;
  const nodes = st.map(s => ({ stroke: s, box: strokeBox(s) }));
  const parent = nodes.map((_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const vy = my * (isBar(nodes[i], h) || isBar(nodes[j], h) ? 2.2 : 1);
      if (joinable(nodes[i].box, nodes[j].box, mx, vy, h)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  nodes.forEach((n, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n.stroke); });
  const parts = [...groups.values()].map(g => ({ strokes: g, box: unionBox(g.map(strokeBox)) }));
  return parts.sort((p, q) => readingOrder(p.box, q.box));
}

function readingOrder(a, c) {
  const overlap = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
  if (overlap > 0.5 * Math.min(a.y1 - a.y0, c.y1 - c.y0)) return a.x0 - c.x0;
  return a.y0 - c.y0;
}

// Group button on a selection: the selected strokes become one region. What each came from is
// kept as its pieces (a selected region, or the selected part of it), so the pieces stay movable.
// A selection inside a single region simply splits it off as a region of its own.
function groupStrokes(strokes) {
  clearTimeout(regroupTimer);
  const page = curPage();
  const ids = new Set(strokes.map(s => s.id));
  const comments = [];
  const pieces = [];
  for (const b of page.blocks) {
    if (!b.strokeIds.some(id => ids.has(id))) continue;
    if (b.comment) comments.push(b.comment);
    for (const p of piecesOf(b)) {
      const inSel = p.filter(id => ids.has(id));
      if (inSel.length) pieces.push(inSel);
    }
    b.strokeIds = b.strokeIds.filter(id => !ids.has(id));
  }
  const inPieces = new Set(pieces.flat());
  const loose = [...ids].filter(id => !inPieces.has(id));
  if (loose.length) pieces.push(loose);
  page.blocks = page.blocks.filter(b => b.strokeIds.length);
  const nb = newBlock();
  nb.strokeIds = [...ids];
  if (pieces.length > 1) nb.pieces = pieces;
  nb.comment = comments.join('; ');
  page.blocks.push(nb);
  toast(pieces.length > 1 ? `Grouped ${pieces.length} pieces into one equation` : 'Made into its own region');
  refreshBlocks(page);
}

function newBlock() {
  return { id: ++blockSeq, strokeIds: [], sig: '', version: 0, status: 'stale', model: null, result: null, edit: null, confirmed: false, figure: null, comment: '', suggest: null };
}

// ----------------------------------------------------------------------------------- API
// Where the AI runs: the local server when the app comes from it (localhost, or the LAN address with
// its token); otherwise the cloud (Supabase Edge Function ink2latex-ai) with the 📡 Send login.
// ?ai=cloud forces the cloud, e.g. to test it from this PC.
const AI_CLOUD = new URLSearchParams(location.search).get('ai') === 'cloud'
  || new URLSearchParams(location.search).has('join') || !!settings.studentLecture
  || !(['localhost', '127.0.0.1'].includes(location.hostname) || TOKEN);
async function aiFetch(method, body) {
  if (!AI_CLOUD) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-ink-token'] = TOKEN;
    return fetch(method === 'GET' ? '/api/engines' : '/api/transcribe', { method, headers, body });
  }
  const { SUPABASE_URL, SUPABASE_KEY } = await import('../config.js?v=2026-10-06.0545');
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  let url = `${SUPABASE_URL}/functions/v1/ink2latex-ai`, token;
  if (student?.active()) {
    // a student: their lecture decides what they may use (Settings → Students of the lecturer)
    token = await student.accessToken();
    const lec = student.lecture().id;
    if (method === 'GET') url += `?lecture=${lec}`;
    else body = JSON.stringify({ ...JSON.parse(body), lecture_id: lec });
    const own = (() => { try { return localStorage.getItem('ink2latex.ownKey') || ''; } catch { return ''; } })();
    if (own) headers['x-ai-key'] = own;
  } else {
    token = await send?.accessToken();
  }
  if (!token) throw new Error('Sign in under 📡 Send to use the AI (no local server here)');
  headers.Authorization = `Bearer ${token}`;
  return fetch(url, { method, body, headers });
}

async function api(body) {
  const res = await aiFetch('POST', JSON.stringify(body));
  const j = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(j.error || res.statusText);
  state.cost += j.cost || 0;
  state.calls++;
  const e = engineOf(body.model);
  const c = (state.costBy[e] ||= { cost: 0, calls: 0 });
  c.cost += j.cost || 0;
  c.calls++;
  renderCost();
  return j;
}

const pageOf = b => state.pages.find(p => p.blocks.includes(b)) || curPage();
const oneLine = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

// what the other regions on the page currently say (hints for disambiguating symbols)
function contextFor(b, page) {
  const lines = [];
  sortedBlocks(page).forEach(({ b: o }, i) => {
    if (o === b || !o.result || o.result.kind === 'empty' || lines.length >= 20) return;
    lines.push(`- region ${i + 1} (${o.result.kind}): ${oneLine(sourceOf(o))}${o.comment ? ` (writer's note: ${oneLine(o.comment, 120)})` : ''}`);
  });
  return lines.join('\n');
}

// The images a region is read from.
// primary: the region at the page's true scale with its neighbours in grey (Settings: "Read regions
//   in their page"), or the classic tight, zoomed crop when that is off.
// alt: a second, differently made image for the second reading: the same scale without neighbours
//   (or the classic crop when the primary has no neighbours), so the two readings do not share
//   every weakness of one picture.
// A region whose parts were moved far apart is drawn without neighbours (its window would be
// mostly other writing).
function spreadOut(b, page) {
  const parts = partsOf(b, page);
  if (parts.length < 2) return false;
  const area = x => Math.max(1, (x.x1 - x.x0) * (x.y1 - x.y0));
  return area(unionBox(parts.map(p => p.box))) > 4 * parts.reduce((a, p) => a + area(p.box), 0);
}
// What the AI core behind this board understands (sent with the engine list). Until it is known,
// and for an older core that does not report it (a cloud function not yet redeployed), regions are
// sent the classic way: its prompt does not know that grey ink is context only.
let coreFeatures = {};
function regionImages(b, page) {
  const strokes = strokesOf(b, page);
  if (!settings.readContext || !coreFeatures.context) return { primary: renderCrop(strokes), alt: renderCrop(strokes) };
  const opts = { lineH: typicalHeight(page.strokes), pageW: board.pageW, pageH: board.pageH };
  const withCtx = !spreadOut(b, page);
  const primary = renderRegion(page.strokes, strokes, { ...opts, context: withCtx });
  const alt = withCtx && primary.neighbours ? renderRegion(page.strokes, strokes, { ...opts, context: false }) : renderCrop(strokes);
  return { primary, alt };
}

// Syntax checks on a reading. They never change what was read: a parse failure asks the model to
// repair the LaTeX syntax only, and brackets that do not balance are only pointed out (the writer
// may really have left one open, which is the writer's business).
const mathParts = r => !r ? [] : r.kind === 'math' ? [r.latex]
  : ['text', 'mixed'].includes(r.kind) ? [...String(r.text || '').matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)].map(m => m[1] ?? m[2]) : [];
function latexProblem(r) {
  for (const s of mathParts(r)) {
    if (!s || !s.trim()) continue;
    try { katex.renderToString(s, { throwOnError: true, strict: false }); }
    catch (e) { return String(e.message || e).replace(/^KaTeX parse error:\s*/, '').slice(0, 200); }
  }
  return null;
}
function unbalancedBrackets(r) {
  for (const s of mathParts(r)) {
    // \left( ... \right) and \{ \} are KaTeX's business (it fails on a mismatch); count the plain ones
    const t = String(s || '').replace(/\\(left|right|big|Big|bigg|Bigg)[lr]?\s*(\\[{}]|[()[\]|.])/g, '').replace(/\\[{}]/g, '');
    const n = c => t.split(c).length - 1;
    if (n('(') !== n(')')) return `Round brackets do not balance as read (${n('(')} open, ${n(')')} closed): check the ink`;
    if (n('[') !== n(']') && !/[[(][^[\]()]*,[^[\]()]*[)\]]/.test(t)) return `Square brackets do not balance as read (${n('[')} open, ${n(']')} closed): check the ink`;
  }
  return null;
}

// Live readings are made twice from two different images. When they agree the reading stands;
// when they differ, the final model reads the primary image and the majority wins (all three
// different: the final model's reading, with the alternatives listed as ambiguities). Explicit
// final-model readings (Finalize, re-run) are made once.
async function transcribe(b, modelKey) {
  const page = pageOf(b);
  const strokes = strokesOf(b, page);
  if (!strokes.length) return;
  const ver = ++b.version;
  const imgs = regionImages(b, page);
  b.status = 'busy'; b.model = modelKey; b.error = null;
  renderAll();
  const context = contextFor(b, page), note = b.comment || '';
  const read = (img, model, extra = {}) => api({ task: 'ink', model, image: img.image, mediaType: img.mediaType, width: img.width, height: img.height, context, note, ...extra });
  try {
    const two = settings.twoReadings && modelKey === settings.liveModel && imgs.alt;
    const runs = await Promise.all([read(imgs.primary, modelKey), ...(two ? [read(imgs.alt, modelKey)] : [])]);
    if (b.version !== ver) return;
    let r = runs[0], model = modelKey, agreement = two ? 'agree' : null;
    if (two && !sameReading(runs[0].data, runs[1].data)) {
      const third = await read(imgs.primary, settings.finalModel);
      if (b.version !== ver) return;
      const shown = x => oneLine(readingOf(x.data) || x.data.kind, 80);
      const backed = runs.find(x => sameReading(x.data, third.data));
      r = { ...third, data: { ...third.data, uncertain: [...(third.data.uncertain || [])] } };
      model = settings.finalModel;
      if (backed) {
        agreement = 'majority';
        const other = runs.find(x => x !== backed);
        r.data.uncertain.push(`Two readings differed; a third agreed with this one (the other read: ${shown(other)})`);
      } else {
        agreement = 'split';
        r.data.uncertain.push(`Three readings disagree: ${runs.map(shown).join(' | ')} | ${shown(third)}`);
      }
      r.ms = Math.max(...runs.map(x => x.ms)) + third.ms;
    }
    // syntax: a reading that does not parse is read once more with the error ("repair the LaTeX
    // syntax only"); if that does not parse either, the first reading stays, flagged
    const problem = latexProblem(r.data);
    if (problem) {
      const again = await read(imgs.primary, model, { fix: { latex: readingOf(r.data), error: problem } }).catch(() => null);
      if (b.version !== ver) return;
      if (again && !latexProblem(again.data)) {
        r = { ...again, ms: r.ms + again.ms, data: { ...again.data, uncertain: [...(again.data.uncertain || []), `LaTeX repaired on a second reading (the first did not parse: ${problem})`] } };
      } else {
        r = { ...r, data: { ...r.data, uncertain: [...(r.data.uncertain || []), `The LaTeX does not render: ${problem}`] } };
      }
    }
    const unb = unbalancedBrackets(r.data);
    if (unb) r = { ...r, data: { ...r.data, uncertain: [...(r.data.uncertain || []), unb] } };
    Object.assign(b, { result: r.data, ms: r.ms, model, agreement, pageAgree: null, status: 'ok', edit: null, suggest: null, orig: null });
  } catch (err) {
    if (b.version !== ver) return;
    Object.assign(b, { status: 'error', error: err.message });
  }
  renderAll();
  if (b.forceEval && b.status === 'ok') { b.forceEval = false; requestAnswer(b); }
  else maybeEvaluate(b);
  scheduleInterpret();
  saveSoon();
}

// double click / double tap on a region: answer its "= ?" / "= ?AI" now (reading new ink first if needed)
function requestAnswer(b) {
  if (b.status === 'busy' || b.status === 'stale') {
    b.forceEval = true;
    if (b.status === 'stale') transcribe(b, settings.liveModel);
    toast('Reading the ink first…');
    return;
  }
  const q = questionOf(b);
  if (!q) { toast('No "= □" or "= ?" in this region'); return; }
  evaluateBlock(b, q, true);
}

board.onDoubleTap = p => {
  clearTimeout(regroupTimer);
  regroup(); // take in what was written just now
  const hit = regionAt(p);
  if (hit) requestAnswer(hit.b);
};

// ----------------------------------------------------------------------------------- "= □" / "= ?" and "= □ AI" / "= ?AI"
// "= □" or "= ?"      -> calculator: the model translates to a math.js expression using values from
//                        the page, math.js computes (reliable arithmetic and units).
// "= □ AI" or "= ?AI" -> the AI (Opus, high effort) works it out and shows key steps.
function questionOf(b) {
  const r = b.result;
  if (!r || !['math', 'mixed', 'text'].includes(r.kind)) return null;
  // normalise the many ways a transcription can write the marker: \text{???}, \, spacing, \Box, □ ...
  const src = String(sourceOf(b))
    .replace(/\$/g, '')
    .replace(/\\(text|mathrm|mathit|operatorname|textrm|mathbf|textbf)\s*\{([^{}]*)\}/g, '$2')
    // only an EMPTY box is an answer box (\boxed{x=5} is a boxed result, not a question)
    .replace(/\\(boxed|fbox|framebox)\{(\s|~|\\[,;: ]|\\q?quad|\\phantom\{[^{}]*\}|\\hspace\{[^{}]*\})*\}|\\(square|Box)\b|\[\s*\]|□|▢|☐|⬜/g, '□')
    .replace(/\\q?quad|\\phantom\{[^{}]*\}/g, ' ')
    // multi-line layouts: "\begin{aligned} N &= … \\ &= ? \end{aligned}" asks the same as "N = … = ?"
    .replace(/\\(begin|end)\{(aligned|align\*?|gathered|split|array)\}(\{[^{}]*\})?|\\\\|&/g, ' ')
    .replace(/\\[,;:! ]|\\(right|left)[.)]?/g, ' ')
    .replace(/\s+/g, '')
    .replace(/[.,;]+$/, '');
  if (!src.includes('=')) return null;
  // the marker: "?", "???", "□", or both ("□?", "?□": models sometimes write the box and the question mark)
  if (/=(\?+□?|□\?*)A\.?I\.?$/i.test(src)) return 'ai';
  // "= ?N" / "= □ N": a number; "= ?S" / "= □ S": a symbolic result (capital letters only, so a
  // variable n or s after the "?" is not taken for the choice)
  if (/=(\?+□?|□\?*)N$/.test(src)) return 'num';
  if (/=(\?+□?|□\?*)S$/.test(src)) return 'sym';
  if (/=(\?+□?|□\?*)$/.test(src)) return 'calc';
  // the drawn box itself: "=" and an empty rectangle in the region, whatever the transcription made of it
  if (answerBoxOf(b, pageOf(b))) return /A\.?I\.?$/i.test(src) ? 'ai' : /N$/.test(src) ? 'num' : /S$/.test(src) ? 'sym' : 'calc';
  return null;
}

function maybeEvaluate(b) {
  if (!settings.autoEval) return;
  const q = questionOf(b);
  if (q && !(b.answer && b.answer.expr === sourceOf(b) && b.answer.mode === q)) evaluateBlock(b, q);
}

// explicit: asked for by the user (double click, button); such an answer is shown even without a
// "= □" / "= ?" in the writing. Automatic answers are shown only while the question is there.
async function evaluateBlock(b, mode = questionOf(b) || 'calc', explicit = false) {
  const page = pageOf(b);
  const expr = sourceOf(b);
  const ver = (b.ansVersion = (b.ansVersion || 0) + 1);
  b.answer = { status: 'busy', mode, expr, explicit };
  renderAll();
  try {
    const body = mode === 'ai'
      ? { task: 'solve', model: heavyModel(), expr, context: contextFor(b, page) }
      : { task: 'evaluate', model: settings.finalModel, expr, context: contextFor(b, page), force: { num: 'numeric', sym: 'symbolic' }[mode] };
    const r = await api(body);
    if (b.ansVersion !== ver) return;
    b.answer = { status: 'ok', mode, expr, data: r.data, ms: r.ms, explicit, model: body.model };
  } catch (err) {
    if (b.ansVersion !== ver) return;
    b.answer = { status: 'error', mode, expr, error: err.message, explicit };
  }
  renderAll();
  saveSoon();
}

// {latex, label, cls} for the answer of a block, or null
function answerValue(b) {
  const a = b.answer;
  if (!a || (!a.explicit && !questionOf(b))) return null;
  if (a.status === 'busy') return { latex: null, label: a.mode === 'ai' ? `${heavyName()} is working it out…` : 'calculating…', cls: 'busy' };
  if (a.status === 'error') return { latex: null, label: a.error, cls: 'err' };
  const d = a.data;
  if (a.mode === 'ai') return { latex: d.answer_latex, label: `AI answer (${MODELS[a.model] || heavyName()}): check`, cls: 'ai' };
  if (d.kind === 'numeric' && d.computed && !d.computed.error) {
    return { latex: d.computed.latex, label: 'calculated with math.js', cls: 'calc' };
  }
  if (d.kind === 'numeric') return { latex: null, label: `could not calculate: ${d.computed?.error || 'no expression'}`, cls: 'err' };
  if (d.kind === 'symbolic' && d.symbolic_latex) return { latex: d.symbolic_latex, label: 'symbolic, by the model: check', cls: 'ai' };
  return { latex: null, label: d.note || 'not enough information on the page', cls: 'err' };
}

function answerHtml(b, detailed) {
  const v = answerValue(b);
  if (!v) return '';
  const a = b.answer;
  let html = `<div class="answer ${v.cls}">${v.latex ? '= ' + tex(v.latex, false) + (v.exact ? ` <span class="dim">(${tex(v.exact, false)})</span>` : '') : ''} <span class="tag">${esc(v.label)}</span></div>`;
  if (detailed && a.status === 'ok') {
    const d = a.data;
    const parts = [];
    if (a.mode === 'ai') parts.push(...(d.steps || []).map(s => `<li>${renderMixed(s)}</li>`));
    else {
      if (d.mathjs) parts.push(`<li>math.js: <code>${esc(d.mathjs)}</code>${d.target_unit ? ` → ${esc(d.target_unit)}` : ''}</li>`);
      parts.push(...(d.variables || []).map(x => `<li>${tex(x.symbol, false)} = ${tex(x.value, false)} <span class="dim">(${esc(x.source)})</span></li>`));
    }
    if (d.note) parts.push(`<li class="dim">${renderMixed(d.note)}</li>`);
    if (parts.length) html += `<details class="ans-details"><summary>${a.mode === 'ai' ? 'Steps' : 'How it was calculated'}</summary><ul>${parts.join('')}</ul></details>`;
  }
  return html;
}

// answers written on the page, right after the question
// Answer boxes ("= □"): closed, roughly rectangular strokes (snapped or freehand) with nothing
// written inside them. A rectangle with writing in it (a diagram) is not an answer box.
function shapeKind(s) {
  if (['rectangle', 'quadrilateral'].includes(s.shape)) return s.shape;
  if (s._kindOf !== s.pts) { s._kindOf = s.pts; s._kind = s.pts.length > 4 ? recognize(s.raw || s.pts)?.type || null : null; }
  return s._kind;
}
function answerBoxesOf(b, page = curPage()) {
  const out = [];
  const st = strokesOf(b, page);
  const lh = typicalHeight(page.strokes); // letter height on this page
  for (const s of st) {
    // really rectangular (4 corners): a closed letter such as σ, o, D or e is not a box
    if (!['rectangle', 'quadrilateral'].includes(shapeKind(s))) continue;
    const bx = strokeBox(s);
    const w = bx.x1 - bx.x0, h = bx.y1 - bx.y0;
    if (w < Math.max(20, 1.2 * lh) || h < Math.max(14, 0.6 * lh)) continue; // an answer box is bigger than a letter
    // it ends its line: after it may only come a short "AI"
    const after = st.filter(o => {
      if (o === s) return false;
      const ob = strokeBox(o), cy = (ob.y0 + ob.y1) / 2;
      return ob.x0 > bx.x1 - 0.1 * w && cy > bx.y0 && cy < bx.y1;
    });
    if (after.length && unionBox(after.map(strokeBox)).x1 - bx.x1 > 3 * lh) continue;
    const inner = { x0: bx.x0 + 0.1 * w, x1: bx.x1 - 0.1 * w, y0: bx.y0 + 0.1 * h, y1: bx.y1 - 0.1 * h };
    const filled = page.strokes.some(o => {
      if (o === s) return false;
      const ob = strokeBox(o), cx = (ob.x0 + ob.x1) / 2, cy = (ob.y0 + ob.y1) / 2;
      return cx > inner.x0 && cx < inner.x1 && cy > inner.y0 && cy < inner.y1;
    });
    if (!filled) out.push({ stroke: s, box: bx });
  }
  return out.sort((p, q) => readingOrder(p.box, q.box));
}
const answerBoxOf = (b, page) => answerBoxesOf(b, page)[0]?.box || null;

// One question per answer box: a region that has come to contain two or more empty answer boxes
// (e.g. a second equation written just below the first) is split, each stroke going to the box on
// its own line.
function splitAtAnswerBoxes(page) {
  for (const b of page.blocks.slice()) {
    if (sigOf(b.strokeIds) === b.sig) continue; // unchanged since it was last read
    const boxes = answerBoxesOf(b, page);
    if (boxes.length < 2) continue;
    const groups = boxes.map(x => ({ ids: [x.stroke.id], box: x.box }));
    for (const s of strokesOf(b, page)) {
      if (boxes.some(x => x.stroke === s)) continue;
      const sb = strokeBox(s), cy = (sb.y0 + sb.y1) / 2;
      let best = groups[0], bestScore = -Infinity;
      for (const g of groups) {
        // the box on the same line: most vertical overlap, otherwise the nearest one vertically
        const overlap = Math.min(sb.y1, g.box.y1) - Math.max(sb.y0, g.box.y0);
        const score = overlap > 0 ? overlap : -Math.abs(cy - (g.box.y0 + g.box.y1) / 2);
        if (score > bestScore) { bestScore = score; best = g; }
      }
      best.ids.push(s.id);
    }
    page.blocks = page.blocks.filter(x => x !== b);
    cardEls.get(b.id)?.remove();
    cardEls.delete(b.id);
    groups.forEach((g, i) => {
      const nb = newBlock();
      nb.strokeIds = g.ids;
      if (i === 0) nb.comment = b.comment;
      page.blocks.push(nb);
    });
    toast(`${groups.length} answer boxes: split into ${groups.length} questions`);
  }
}

// answers written on the page: inside the answer box ("= □"), scaled to fit, or else right after
// the question; an unanswered question gets a "= ?" button there, one tap computes it
function renderAnswers(list) {
  const layer = $('#answers');
  layer.innerHTML = '';
  const s = board.s;
  for (const item of list) {
    const { b } = item;
    const v = answerValue(b);
    const q = questionOf(b);
    if (!v && !q) continue;
    const parts = item.parts || partsOf(b);
    if (!parts.length) continue;
    const box = parts[parts.length - 1].box; // the last part, where the "= ?" is
    const abox = answerBoxOf(b);
    const h = (box.y1 - box.y0) * s;
    let el;
    if (!v || v.cls === 'err') {
      el = document.createElement('button');
      el.className = 'ask-chip';
      el.textContent = ({ ai: '= ?AI', num: '= ?N', sym: '= ?S' }[q] || '= ?') + (v ? ' ↻' : '');
      el.title = v ? `${v.label}. Tap to try again.` : { ai: 'Tap: let the AI work it out', num: 'Tap: calculate a number (math.js, values from the page)', sym: 'Tap: work out a symbolic result' }[q] || 'Tap: calculate (math.js, values from the page)';
      el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); requestAnswer(b); });
    } else {
      el = document.createElement('div');
      el.className = `page-answer ${v.cls}`;
      el.innerHTML = v.latex ? tex(v.latex, false) + (v.cls === 'ai' ? '<sup class="ai-tag">AI</sup>' : '') : '…';
    }
    layer.appendChild(el);
    if (abox) {
      // inside the box: centred, scaled to fit (the box is the answer field)
      const bw = (abox.x1 - abox.x0) * s, bh = (abox.y1 - abox.y0) * s;
      if (el.classList.contains('page-answer')) {
        el.style.fontSize = '40px';
        el.style.transformOrigin = '0 0';
        const k = Math.min(0.88 * bw / el.offsetWidth, 0.75 * bh / el.offsetHeight, 1.5);
        el.style.transform = `scale(${k})`;
        el.style.left = (abox.x0 * s + (bw - el.offsetWidth * k) / 2) + 'px';
        el.style.top = (abox.y0 * s + (bh - el.offsetHeight * k) / 2) + 'px';
      } else {
        el.style.left = (abox.x0 * s + (bw - el.offsetWidth) / 2) + 'px';
        el.style.top = (abox.y0 * s + (bh - el.offsetHeight) / 2) + 'px';
      }
    } else {
      if (el.classList.contains('page-answer')) el.style.fontSize = Math.max(16, Math.min(40, h * 0.6)) + 'px';
      el.style.left = (box.x1 * s + 10) + 'px';
      el.style.top = (box.y0 * s + (h - el.offsetHeight) / 2) + 'px';
    }
  }
}

async function makeFigure(b) {
  const strokes = strokesOf(b, pageOf(b));
  if (!strokes.length) return;
  const { image, mediaType, width, height } = renderCrop(strokes, 1200);
  b.figureBusy = true; b.figureError = null;
  renderAll();
  try {
    const r = await api({ task: 'figure', model: heavyModel(), image, mediaType, width, height, note: b.comment || '' });
    b.figure = r.data;
  } catch (err) {
    b.figureError = err.message;
  }
  b.figureBusy = false;
  renderAll();
  saveSoon();
}

// ----------------------------------------------------------------------------------- page interpretation
let interpBusy = false;
let interpTimer = 0;
const INTERP_IDLE_MS = 10000;

// what the page interpretation depends on: the strokes and the writer's comments
const interpSig = page => page.strokes.map(s => s.id).join(',') + '|' + page.blocks.map(b => b.comment || '').join('|');

function scheduleInterpret() {
  clearTimeout(interpTimer);
  if (!settings.autoInterp || assign?.quiet()) return;
  interpTimer = setTimeout(() => {
    const page = curPage();
    if (board.active || interpBusy || page.blocks.some(b => b.status === 'busy') || regroupPending()) { scheduleInterpret(); return; }
    if (!page.blocks.some(b => b.result && b.result.kind !== 'empty')) return;
    if (page.interp && page.interp.stateSig === interpSig(page)) return; // nothing changed
    interpretPage();
  }, INTERP_IDLE_MS);
}
function regroupPending() {
  const page = curPage();
  const assigned = new Set(page.blocks.flatMap(b => b.strokeIds));
  return page.strokes.some(s => !assigned.has(s.id));
}

async function interpretPage() {
  clearTimeout(regroupTimer);
  clearTimeout(interpTimer);
  regroup();
  const page = curPage();
  const list = sortedBlocks(page);
  if (!list.length) { toast('Nothing on this page yet'); return; }
  // every part of a spread-out region carries the region's number
  const labels = list.flatMap(({ b }, i) => partsOf(b, page).map(pt => ({ box: pt.box, n: i + 1 })));
  const area = { x0: 0, y0: 0, x1: board.pageW, y1: Math.min(board.pageH, Math.max(...list.map(o => o.box.y1)) + 40) };
  const { image, mediaType, width, height } = renderCrop(page.strokes, 1600, labels, area);
  const context = list.map(({ b }, i) => {
    const r = b.result;
    const reading = r ? `[${r.kind}] ${oneLine(sourceOf(b), 300)}` : '[not transcribed]';
    return `Region ${i + 1}: ${reading}${b.comment ? `  (writer's note: ${oneLine(b.comment, 200)})` : ''}`;
  }).join('\n');
  interpBusy = true;
  renderInterp();
  try {
    // the context interpretation (which starts from the region readings) and, in parallel, an
    // independent reading of the same page image that is NOT shown the region readings
    const [r, blind] = await Promise.all([
      api({ task: 'board', model: settings.finalModel, image, mediaType, width, height, context }),
      settings.pageCheck && coreFeatures.pageread ? api({ task: 'pageread', model: settings.finalModel, image, mediaType, width, height }).catch(() => null) : null,
    ]);
    const regionIds = list.map(o => o.b.id);
    activeErr = null; board.errorMarks = []; board.request();
    page.interp = { data: r.data, model: settings.finalModel, ms: r.ms, regionIds, sig: page.strokes.map(s => s.id).join(','), stateSig: interpSig(page), checked: !!blind };
    for (const reg of r.data.regions) {
      const b = page.blocks.find(x => x.id === regionIds[reg.region - 1]);
      if (b && reg.changed && reg.reading !== sourceOf(b) && !b.confirmed) b.suggest = { kind: reg.reading_kind, reading: reg.reading, reason: reg.reason };
    }
    if (blind) reconcilePageReading(page, regionIds, blind.data.regions || []);
    // merges only change the grouping (the merged ink is read again), so they can be applied automatically
    if (settings.autoMerge || settings.autoAccept) r.data.merges.forEach(m => applyMerge(page, m));
    // a suggestion that only one of the two page readings supports is never applied automatically
    if (settings.autoAccept) page.blocks.filter(b => b.suggest && !b.suggest.weak).forEach(acceptSuggestion);
  } catch (err) {
    page.interp = { error: err.message };
  }
  interpBusy = false;
  renderAll();
  saveSoon();
}

// Compare the independent page reading with each region. Three outcomes per region:
// - it agrees with the current reading: the region is marked as confirmed by the page reading;
// - the context interpretation already suggested a change: the suggestion is strengthened when the
//   independent reading agrees with it, and made "weak" (never applied automatically) when the
//   independent reading sides with the current reading instead;
// - otherwise, when it differs: a weak suggestion (shown on the card, never applied automatically).
// Regions that were confirmed or edited by hand are the writer's word and are left alone.
const asResult = (kind, reading) => ({ kind, latex: kind === 'math' ? reading : '', text: kind === 'math' ? '' : reading });
function reconcilePageReading(page, regionIds, regions) {
  for (const reg of regions) {
    const b = page.blocks.find(x => x.id === regionIds[reg.region - 1]);
    if (!b || !b.result || b.confirmed || b.edit != null) continue;
    const indep = asResult(reg.reading_kind, reg.reading);
    const agreesNow = sameReading(b.result, indep);
    b.pageAgree = agreesNow;
    if (b.suggest) {
      if (sameReading(asResult(b.suggest.kind, b.suggest.reading), indep)) {
        b.suggest.reason = `${b.suggest.reason ? b.suggest.reason + ' ' : ''}An independent reading of the page agrees.`;
      } else if (agreesNow) {
        b.suggest.weak = true;
        b.suggest.reason = `${b.suggest.reason ? b.suggest.reason + ' ' : ''}But an independent reading of the page agrees with the current reading.`;
      }
      continue;
    }
    if (agreesNow) continue;
    b.suggest = {
      kind: reg.reading_kind, reading: reg.reading, weak: true, label: 'An independent reading of the page gives',
      reason: (reg.uncertain || []).length ? `Read from the whole page without the region readings. Unsure: ${reg.uncertain.join('; ')}` : 'Read from the whole page without the region readings.',
    };
  }
}

// keep what the region-by-region transcription said, so a context correction can be undone
function rememberOriginal(b) {
  if (b.model !== 'context') b.orig = { result: b.result, edit: b.edit, model: b.model, ms: b.ms };
}

function acceptSuggestion(b) {
  const s = b.suggest;
  if (!s) return;
  rememberOriginal(b);
  b.result = { kind: s.kind, latex: s.kind === 'math' ? s.reading : '', text: s.kind === 'math' ? '' : s.reading, uncertain: [s.reason ? `Read in context: ${s.reason}` : 'Read in context'] };
  Object.assign(b, { edit: null, suggest: null, model: 'context', ms: 0, status: 'ok' });
  maybeEvaluate(b);
}

function revertOriginal(b) {
  if (!b.orig) return;
  Object.assign(b, b.orig, { orig: null, suggest: null });
}

// a merge suggested by the page interpretation: group the regions, then read the combined ink again
function applyMerge(page, m) {
  const ids = page.interp.regionIds;
  const blocks = m.regions.map(n => page.blocks.find(b => b.id === ids[n - 1])).filter(Boolean);
  groupBlocks(page, blocks);
  m.done = true;
}

function renderDoc(md) {
  return String(md).split(/\n\s*\n/).map(par => {
    const h = par.match(/^\s*#{1,6}\s+(.*)$/s);
    if (h) return `<h4>${renderMixed(h[1])}</h4>`;
    const t = par.trim();
    // a whole paragraph in *...* (figure descriptions): italic, even when it contains $math$
    const it = t.match(/^\*([^*][\s\S]*[^*])\*$/);
    if (it) return `<p><em>${renderMixed(it[1])}</em></p>`;
    return `<p>${renderMixed(t)}</p>`;
  }).join('');
}

function renderInterp() {
  const box = $('#interpCard');
  if (box.contains(document.activeElement) && document.activeElement.classList.contains('clarify-in')) return; // being typed in
  const page = curPage();
  const it = page.interp;
  if (interpBusy) {
    box.innerHTML = `<div class="card"><div class="card-head"><strong>Page interpretation</strong><span class="meta"><span class="busy">${MODELS[settings.finalModel]} is reading the whole page …</span></span></div></div>`;
    return;
  }
  if (!it) { box.innerHTML = ''; return; }
  if (it.error) {
    box.innerHTML = `<div class="card"><div class="card-head"><strong>Page interpretation</strong></div><div class="error-msg">${esc(it.error)}</div></div>`;
    return;
  }
  const d = it.data;
  const stale = it.sig !== page.strokes.map(s => s.id).join(',');
  const merges = d.merges.filter(m => !m.done);
  const nSuggest = page.blocks.filter(b => b.suggest).length;
  box.innerHTML = `
    <div class="card">
      <div class="card-head"><strong>Page interpretation</strong><span class="meta">${MODELS[it.model]} · ${it.ms} ms${stale ? ' · page changed since' : ''}</span></div>
      <div class="render doc"><p class="muted">${renderMixed(d.summary)}</p>${renderDoc(d.document)}</div>
      ${merges.map((m, i) => `<div class="suggest">Regions ${m.regions.join(' + ')} belong together: ${m.reading_kind === 'math' ? tex(m.reading, false) : renderMixed(m.reading)}
        <div class="why">${esc(m.reason)}</div>
        <div class="actions"><button data-merge="${d.merges.indexOf(m)}">Group</button></div></div>`).join('')}
      ${nSuggest ? `<div class="suggest">${nSuggest} reading correction${nSuggest > 1 ? 's' : ''} suggested on the cards below.</div>` : ''}
      ${errorsOf(it).map((e, i) => e.dismissed
        ? `<div class="errbox dismissed" data-err="${i}"><strong>Not an error</strong>${e.note ? `: ${esc(e.note)}` : ''}
            <span class="dim">(${renderMixed(e.text)})</span></div>`
        : `<div class="errbox ${activeErr === i ? 'on' : ''}" data-err="${i}" title="Click to mark it on the page">
        <strong>Possible error</strong> <span class="dim">(not changed${e.regions.length ? ` · region ${e.regions.join(', ')}` : ''})</span><br>${renderMixed(e.text)}
        ${activeErr === i && e.locating ? '<div class="dim">locating…</div>' : ''}
        <div class="clarify">
          <input class="clarify-in" placeholder="Clarify, e.g. &quot;the written z is the atomic number Z&quot;" value="${esc(e.draft || '')}">
          <button data-clarify="${i}" title="Add this as a note to the region(s), read them again and re-interpret the page">Clarify</button>
          <button data-noerr="${i}" title="Dismiss: this is not an error">Not an error</button>
        </div></div>`).join('')}
      <div class="actions">
        ${merges.length || nSuggest ? '<button data-i="all">Accept all</button>' : ''}
        <button data-i="copy">Copy document</button>
        <button data-i="rerun">↻ Re-interpret</button>
        <button data-i="close">Close</button>
      </div>
    </div>`;
}

// ----------------------------------------------------------------------------------- possible errors on the page
let activeErr = null;

// errors as [{text, regions}] (older sessions stored plain strings)
function errorsOf(it) {
  const list = it?.data?.possible_errors || [];
  return list.map((e, i) => {
    if (typeof e === 'string') list[i] = e = { text: e, regions: [] };
    return e;
  });
}

function clearErrorMarks(dropCache) {
  const it = curPage().interp;
  if (dropCache && it?.data) errorsOf(it).forEach(e => { delete e.marks; });
  if (activeErr === null && !board.errorMarks.length) return;
  activeErr = null;
  board.errorMarks = [];
  board.request();
  renderInterp();
}

// Click on a possible error: mark its region(s) at once (light red), then ask the final model where
// exactly in each region the problem is and tighten the marks to those symbols.
// The writer explains a possible error ("the written z is the atomic number Z") or dismisses it.
// A clarification becomes a note on the region(s) concerned; they are read again with it and the
// page is interpreted again, so later readings keep the knowledge.
function clarifyError(i, note) {
  const page = curPage();
  const it = page.interp;
  const err = errorsOf(it)[i];
  if (!err) return;
  clearErrorMarks(false);
  Object.assign(err, { dismissed: true, note, draft: '' });
  const blocks = err.regions.map(n => page.blocks.find(b => b.id === it.regionIds[n - 1])).filter(Boolean);
  if (note) {
    for (const b of blocks) {
      if (!(b.comment || '').includes(note)) b.comment = b.comment ? `${b.comment}; ${note}` : note;
      transcribe(b, settings.finalModel);
    }
    toast(blocks.length ? 'Noted: reading again with your clarification' : 'Noted');
  }
  renderAll();
  saveSoon();
  // re-interpret once the regions have been read again
  if (note && blocks.length) {
    const whenRead = () => (page.blocks.some(b => b.status === 'busy') ? setTimeout(whenRead, 800) : curPage() === page && interpretPage());
    setTimeout(whenRead, 800);
  } else {
    renderInterp();
  }
}

// keep what is typed in a clarify field across re-renders
$('#interpCard').addEventListener('input', e => {
  if (!e.target.classList.contains('clarify-in')) return;
  const i = Number(e.target.closest('.errbox').dataset.err);
  const err = errorsOf(curPage().interp)[i];
  if (err) err.draft = e.target.value;
});
$('#interpCard').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.classList.contains('clarify-in')) return;
  const i = Number(e.target.closest('.errbox').dataset.err);
  clarifyError(i, e.target.value.trim());
});

async function toggleErrorMark(i) {
  const page = curPage();
  const it = page.interp;
  const err = errorsOf(it)[i];
  if (!err || activeErr === i) { clearErrorMarks(false); return; }
  activeErr = i;
  const blocks = err.regions.map(n => page.blocks.find(b => b.id === it.regionIds[n - 1])).filter(Boolean);
  if (!blocks.length) { board.errorMarks = []; board.request(); renderInterp(); toast('No region given for this error'); return; }
  const show = () => {
    if (activeErr !== i) return;
    board.errorMarks = err.marks || blocks.flatMap(b => partsOf(b, page).map(pt => ({ ...pt.box, coarse: true })));
    board.request();
    scrollToMark(board.errorMarks[0]);
    renderInterp();
  };
  show();
  if (err.marks) return;
  err.locating = true;
  renderInterp();
  const marks = [];
  await Promise.all(blocks.map(async b => {
    const strokes = strokesOf(b, page);
    if (!strokes.length) return;
    const crop = renderCrop(strokes);
    try {
      const r = await api({ task: 'locate', model: settings.finalModel, image: crop.image, mediaType: crop.mediaType,
        width: crop.width, height: crop.height, expr: err.text, context: sourceOf(b) });
      const { scale, ox, oy } = crop.map;
      if (r.data.found) for (const q of r.data.boxes) {
        marks.push({ x0: q.x0 / scale + ox, y0: q.y0 / scale + oy, x1: q.x1 / scale + ox, y1: q.y1 / scale + oy });
      }
    } catch { /* keep the region mark */ }
  }));
  err.locating = false;
  if (marks.length) err.marks = marks;
  else toast('Could not pin it down: the whole region is marked');
  show();
}

function scrollToMark(m) {
  if (!m) return;
  const wrap = $('#boardWrap'), s = board.s;
  const y = m.y0 * s, vis = wrap.scrollTop, h = wrap.clientHeight;
  if (y < vis || y > vis + h - 60) wrap.scrollTo({ top: Math.max(0, y - h / 3), behavior: 'smooth' });
}

$('#interpCard').addEventListener('click', e => {
  const cb = e.target.closest('[data-clarify], [data-noerr]');
  if (cb) {
    const i = Number(cb.dataset.clarify ?? cb.dataset.noerr);
    const note = cb.closest('.errbox').querySelector('.clarify-in').value.trim();
    clarifyError(i, cb.dataset.clarify != null ? note : note || '');
    return;
  }
  if (e.target.closest('.clarify')) return; // typing in the field does not toggle the marks
  const eb = e.target.closest('.errbox');
  if (eb && !eb.classList.contains('dismissed')) { toggleErrorMark(Number(eb.dataset.err)); return; }
  const btn = e.target.closest('button');
  if (!btn) return;
  const page = curPage();
  const it = page.interp;
  if (btn.dataset.merge != null) applyMerge(page, it.data.merges[Number(btn.dataset.merge)]);
  const act = btn.dataset.i;
  if (act === 'all') {
    it.data.merges.filter(m => !m.done).forEach(m => applyMerge(page, m));
    page.blocks.filter(b => b.suggest).forEach(acceptSuggestion);
  }
  if (act === 'copy') copyText(it.data.document, 'Document copied (Markdown + LaTeX)');
  if (act === 'rerun') { interpretPage(); return; }
  if (act === 'close') page.interp = null;
  renderAll();
  saveSoon();
});

// ----------------------------------------------------------------------------------- rendering helpers
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tex(src, display) {
  try { return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: false }); }
  catch { return `<code>${esc(src)}</code>`; }
}

// prose with $inline$ and $$display$$ math
function renderMixed(text) {
  const parts = String(text).split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g);
  return parts.map(p => {
    if (p.startsWith('$$') && p.endsWith('$$') && p.length > 4) return tex(p.slice(2, -2), true);
    if (p.startsWith('$') && p.endsWith('$') && p.length > 2) return tex(p.slice(1, -1), false);
    return esc(p).replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
  }).join('');
}

// Word turns pasted MathML text into a native equation
function toMathML(latex) {
  const html = katex.renderToString(latex, { output: 'mathml', displayMode: true, throwOnError: false, strict: false });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const math = doc.querySelector('math');
  if (!math) return '';
  const sem = math.querySelector('semantics');
  if (sem) {
    sem.querySelector('annotation')?.remove();
    while (sem.firstChild) math.insertBefore(sem.firstChild, sem);
    sem.remove();
  }
  math.setAttribute('xmlns', 'http://www.w3.org/1998/Math/MathML');
  return math.outerHTML;
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // clipboard API needs https or localhost; fall back for LAN use
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(label);
}

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let toastTimer = 0;
function toast(msg, x, y) {
  const t = $('#toast');
  t.textContent = msg;
  if (x == null) { const r = document.body.getBoundingClientRect(); x = r.width / 2 - 40; y = r.height - 50; }
  t.style.left = x + 'px'; t.style.top = y + 'px';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}
function toastAt(msg, p) {
  const r = $('#board').getBoundingClientRect();
  toast(msg, r.left + p[0] * board.s + 14, r.top + p[1] * board.s - 28);
}

// reading order: rows top to bottom, left to right within a row
function sortedBlocks(page = curPage()) {
  const withBox = page.blocks.map(b => ({ b, box: blockBox(b, page) })).filter(o => o.box);
  withBox.sort((p, q) => {
    const a = p.box, c = q.box;
    const overlap = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
    if (overlap > 0.5 * Math.min(a.y1 - a.y0, c.y1 - c.y0)) return a.x0 - c.x0;
    return a.y0 - c.y0;
  });
  return withBox;
}

// ----------------------------------------------------------------------------------- panel
const cardEls = new Map();

function blockContentHtml(b) {
  const r = b.result;
  if (!r) return b.status === 'busy' ? '<span class="muted">transcribing…</span>' : '<span class="muted">not transcribed yet</span>';
  let html;
  if (r.kind === 'math') html = tex(b.edit ?? r.latex, true);
  else if (r.kind === 'text' || r.kind === 'mixed') html = renderMixed(b.edit ?? r.text);
  else if (r.kind === 'figure') html = `<span class="muted">Figure: ${renderMixed(b.edit ?? r.text)}</span>`;
  else html = '<span class="muted">(nothing legible)</span>';
  if (b.figure) html += `<div class="fig-cap">Redrawn figure (${esc(MODELS[b.figure.model] || heavyName())})</div><img class="fig" alt="redrawn figure" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.figure.svg)}">`;
  if (b.figureBusy) html += `<div class="muted">${heavyName()} is redrawing the figure…</div>`;
  if (b.figureError) html += `<div class="error-msg">${esc(b.figureError)}</div>`;
  return html;
}

function sourceOf(b) {
  const r = b.result;
  if (!r) return '';
  return b.edit ?? (r.kind === 'math' ? r.latex : r.text);
}

// how the reading was reached, for the card header (with a tooltip)
function agreementTag(b) {
  const tags = [];
  if (b.agreement === 'agree') tags.push(['2 readings agree', 'Two readings from two different images of this region gave the same result']);
  if (b.agreement === 'majority') tags.push(['2 of 3 readings', 'Two readings differed; a third reading by the final model agreed with this one']);
  if (b.agreement === 'split') tags.push(['readings disagree', 'Three readings gave three different results: check this one']);
  if (b.pageAgree === true) tags.push(['page reading agrees', 'An independent reading of the whole page gives the same result']);
  return tags.map(([t, tip]) => ` · <span class="agree-tag ${b.agreement === 'split' ? 'split' : ''}" title="${esc(tip)}">${t}</span>`).join('');
}

// What a region's reading asks of you, for the outlines on the page and the panel filter:
// 'bad' = an error, or readings that disagree; 'warn' = something flagged (uncertain parts, a
// suggestion, two of three readings, the page reading differs); 'good' = read with nothing flagged
// or confirmed by you; '' = nothing to judge yet (being read, or empty).
function regionState(b) {
  if (b.status === 'busy') return '';
  if (b.status === 'error') return 'bad';
  const r = b.result;
  if (!r || r.kind === 'empty') return '';
  if (b.confirmed) return 'good';
  if (b.agreement === 'split') return 'bad';
  if (b.suggest || r.uncertain?.length || b.agreement === 'majority' || b.pageAgree === false) return 'warn';
  return 'good';
}
const needsAttention = b => ['warn', 'bad'].includes(regionState(b));

function suggestHtml(b) {
  const s = b.suggest;
  if (!s) return '';
  const shown = s.kind === 'math' ? tex(s.reading, true) : renderMixed(s.reading);
  return `<div class="suggest${s.weak ? ' weak' : ''}">${esc(s.label || 'In context this reads')}: ${shown}<div class="why">${esc(s.reason)}</div>
    <div class="actions"><button data-act="accept">Accept</button><button data-act="dismiss">Dismiss</button></div></div>`;
}

function fillCard(el, b, num) {
  el.classList.toggle('confirmed', !!b.confirmed);
  const focused = el.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName);
  const r = b.result;
  const meta = b.status === 'busy'
    ? `<span class="busy">${MODELS[b.model]} …</span>`
    : b.status === 'ok' && b.model ? `${MODELS[b.model] || b.model}${b.ms ? ` · ${b.ms} ms` : ''}${b.edit != null ? ' · edited' : ''}${agreementTag(b)}` : '';
  const head = `<span class="num">${num}</span><span class="kind">${r ? r.kind : ''}</span><span class="meta">${meta}</span>`;
  if (focused) {
    el.querySelector('.card-head').innerHTML = head;
    el.querySelector('.render').innerHTML = blockContentHtml(b);
    return;
  }
  const isMath = r && r.kind === 'math';
  const other = settings.finalModel === b.model ? settings.liveModel : settings.finalModel;
  el.innerHTML = `
    <div class="card-head">${head}</div>
    <div class="render">${blockContentHtml(b)}</div>
    ${answerHtml(b, true)}
    ${b.error ? `<div class="error-msg">${esc(b.error)}</div>` : ''}
    ${suggestHtml(b)}
    <ul class="uncertain">${(r?.uncertain || []).map(u => `<li>${esc(u)}</li>`).join('')}</ul>
    ${r && r.kind !== 'empty' ? `<details><summary>Source (editable)</summary><textarea spellcheck="false">${esc(sourceOf(b))}</textarea></details>` : ''}
    <input class="comment" placeholder="Comment: what this is meant to be (used as a hint when re-run)" value="${esc(b.comment || '')}">
    <div class="actions">
      ${r ? `<button class="confirm ${b.confirmed ? 'on' : ''}" data-act="confirm" title="Mark as checked against the ink">✓ ${b.confirmed ? 'Confirmed' : 'Confirm'}</button>` : ''}
      ${b.orig ? '<button data-act="original" title="Go back to the region-by-region reading">↶ original</button>' : ''}
      <button data-act="rerun" title="Transcribe again with ${MODELS[other]} (uses your comment)">↻ ${MODELS[other]}</button>
      ${isMath ? '<button data-act="latex" title="Copy LaTeX (also works in Word: Insert > Equation > LaTeX)">LaTeX</button>' : ''}
      ${isMath ? '<button data-act="word" title="Copy as MathML: paste into Word as a native equation">Word</button>' : ''}
      ${r && !isMath && r.kind !== 'empty' ? '<button data-act="text" title="Copy text">Copy</button>' : ''}
      ${r && (isMath || questionOf(b)) ? `<button data-act="calc" title="Calculate with math.js, using values from the page (same as writing = ?)">= ?</button>
        <button data-act="solveai" title="Let ${heavyName()} work it out, with steps (same as writing = ?AI)">= ?AI</button>` : ''}
      ${b.answer ? '<button data-act="noans" title="Remove the answer">✕ Answer</button>' : ''}
      ${num > 1 ? `<button data-act="mergeprev" title="Group this region with region ${num - 1}: read as one equation, pieces stay movable">⇡ Group with ${num - 1}</button>` : ''}
      ${canUngroup(b) ? '<button data-act="ungroup" title="Split into its pieces again, each read on its own (Ctrl+Shift+G)">Ungroup</button>' : ''}
      ${r && r.kind === 'figure' ? '<button data-act="straighten" title="Straighten axes and lines, clean arrowheads, smooth curves - on the page itself (undo with Ctrl+Z)">Straighten</button>' : ''}
      ${r && r.kind === 'figure' && !b.figure ? `<button data-act="figure" title="${heavyName()} redraws the sketch as a clean vector figure (SVG + TikZ), shown below the description" ${b.figureBusy ? 'disabled' : ''}>Redraw as figure</button>` : ''}
      ${b.figure ? '<button data-act="svg">SVG ↓</button><button data-act="tikz">TikZ</button><button data-act="nofig" title="Remove the redrawn figure from this card">✕ Figure</button>' : ''}
    </div>`;
}

function cardFor(b) {
  let el = cardEls.get(b.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = b.id;
  el.addEventListener('mouseenter', () => { board.highlight = blockBox(b); board.request(); framesOf(b.id).forEach(f => f.classList.add('hl')); });
  el.addEventListener('mouseleave', () => { board.highlight = null; board.request(); framesOf(b.id).forEach(f => f.classList.remove('hl')); });
  el.addEventListener('input', e => {
    if (e.target.tagName === 'TEXTAREA') {
      b.edit = e.target.value;
      el.querySelector('.render').innerHTML = blockContentHtml(b);
    } else if (e.target.classList.contains('comment')) {
      b.comment = e.target.value;
    }
    saveSoon();
  });
  el.addEventListener('dblclick', e => { if (e.target.closest('.render')) requestAnswer(b); });
  // an edited source that now ends in "= ?" / "= ?AI" is evaluated when the field is left
  el.addEventListener('change', e => { if (e.target.tagName === 'TEXTAREA') { renderAll(); maybeEvaluate(b); } });
  el.addEventListener('keydown', e => {
    // Enter in the comment field re-runs the region with the comment as a hint
    if (e.key === 'Enter' && e.target.classList.contains('comment')) { e.target.blur(); transcribe(b, settings.finalModel); }
  });
  el.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'confirm') { b.confirmed = !b.confirmed; renderAll(); saveSoon(); }
    if (act === 'rerun') transcribe(b, settings.finalModel === b.model ? settings.liveModel : settings.finalModel);
    if (act === 'latex') copyText(sourceOf(b), 'LaTeX copied');
    if (act === 'word') copyText(toMathML(sourceOf(b)), 'MathML copied - paste into Word');
    if (act === 'text') copyText(sourceOf(b), 'Text copied');
    if (act === 'straighten') { board.applyEdits(straightenFigure(strokesOf(b))); renderAll(); }
    if (act === 'figure') makeFigure(b);
    if (act === 'svg') download(`figure-${b.id}.svg`, b.figure.svg, 'image/svg+xml');
    if (act === 'tikz') copyText(b.figure.tikz, 'TikZ copied');
    if (act === 'nofig') { b.figure = null; renderAll(); saveSoon(); }
    if (act === 'mergeprev') {
      const page = pageOf(b);
      const list = sortedBlocks(page).map(o => o.b);
      const i = list.indexOf(b);
      if (i > 0) groupBlocks(page, [list[i - 1], b]);
    }
    if (act === 'ungroup') ungroup(b);
    if (act === 'calc') evaluateBlock(b, 'calc', true);
    if (act === 'solveai') evaluateBlock(b, 'ai', true);
    if (act === 'noans') { b.answer = null; b.ansVersion = (b.ansVersion || 0) + 1; renderAll(); saveSoon(); }
    if (act === 'accept') { acceptSuggestion(b); renderAll(); saveSoon(); }
    if (act === 'dismiss') { b.suggest = null; renderAll(); saveSoon(); }
    if (act === 'original') { revertOriginal(b); renderAll(); saveSoon(); }
  });
  cardEls.set(b.id, el);
  return el;
}

// frames on the page (overlay in CSS pixels = page units * board.s)
const frameEls = new Map();
let hoverId = null, hoverTimer = 0, badgeDrag = null;

// frame elements of one region (one per part)
const framesOf = id => [...frameEls].filter(([k]) => k.startsWith(id + ':')).map(([, f]) => f);

// region part under a page point (smallest part box that contains it): {b, part}
function regionAt(p) {
  let best = null, area = Infinity;
  for (const { b, parts } of layoutOf()) {
    for (const part of parts) {
      const box = part.box;
      if (p[0] < box.x0 - 6 || p[0] > box.x1 + 6 || p[1] < box.y0 - 6 || p[1] > box.y1 + 6) continue;
      const a = (box.x1 - box.x0) * (box.y1 - box.y0);
      if (a < area) { area = a; best = { b, part }; }
    }
  }
  return best;
}

function setHover(id, delay = 0) {
  clearTimeout(hoverTimer);
  const apply = () => {
    if (hoverId === id) return;
    framesOf(hoverId).forEach(f => f.classList.remove('hover'));
    hoverId = id;
    framesOf(hoverId).forEach(f => f.classList.add('hover'));
  };
  if (delay) hoverTimer = setTimeout(apply, delay); else apply();
}

// checked at most once per screen refresh, however fast the pen reports its position
let hoverPoint = null, hoverRaf = 0;
board.onHover = p => {
  if (!p) { hoverPoint = null; setHover(null, 250); return; }
  hoverPoint = p;
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    if (!hoverPoint) return;
    const hit = regionAt(hoverPoint);
    setHover(hit ? hit.b.id : null, hit ? 0 : 150);
  });
};
// Select tool: pressing inside a box picks that part (a term or line); the badge moves the whole region
// Select tool, like grouping in PowerPoint: pressing on a region selects all of it (a group with
// all its pieces) and a drag moves it; clicking again on a piece of the selected group selects
// just that piece, which can then be moved on its own and stays in the group.
board.pickAt = p => regionAt(p)?.b.strokeIds.slice() || null;
board.pickPartAt = p => regionAt(p)?.part.strokes.map(s => s.id) || null; // Alt + press
board.onTap = (p, fresh) => {
  if (badgeDrag) {
    // a tap on the badge shows the region's card; in Select mode the region also stays selected
    // with its bar (Delete, Group …). While writing, the badge is only for moving quickly.
    const b = badgeDrag;
    badgeDrag = null;
    if (board.tool === 'lasso') board.selectIds(b.strokeIds.slice()); else board.clearSelection();
    settings.panel = true; applyPanel();
    cardEls.get(b.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (fresh || !p) return; // the click that selected the group
  const hit = regionAt(p);
  const sel = board.sel;
  if (!hit || !sel || partsOf(hit.b).length < 2) return;
  const whole = hit.b.strokeIds.length === sel.ids.size && hit.b.strokeIds.every(id => sel.ids.has(id));
  if (whole) board.selectIds(hit.part.strokes.map(s => s.id));
};
function renderFrames(list) {
  const overlay = $('#overlay');
  const keep = new Set();
  const s = board.s;
  list.forEach(({ b, parts: known }, i) => {
    const parts = known || partsOf(b);
    parts.forEach((part, k) => {
      const key = `${b.id}:${k}`;
      keep.add(key);
      let f = frameEls.get(key);
      if (!f) {
        f = document.createElement('div');
        f.className = 'frame';
        f.innerHTML = '<span class="badge" title="Drag to move this region (all its parts); click to show its card"></span>';
        const badge = f.querySelector('.badge');
        // drag a number badge to move the whole region (any tool); a click shows its card
        badge.addEventListener('pointerdown', e => {
          e.preventDefault(); e.stopPropagation();
          badgeDrag = b;
          board.dragFromOutside(e, b.strokeIds);
        });
        badge.addEventListener('pointerenter', () => setHover(b.id));
        badge.addEventListener('pointerleave', () => setHover(null, 250));
        overlay.appendChild(f);
        frameEls.set(key, f);
      }
      const box = part.box;
      f.style.left = (box.x0 * s - 5) + 'px';
      f.style.top = (box.y0 * s - 5) + 'px';
      f.style.width = ((box.x1 - box.x0) * s + 10) + 'px';
      f.style.height = ((box.y1 - box.y0) * s + 10) + 'px';
      const st = regionState(b);
      f.className = 'frame' + (k > 0 ? ' part' : '') + (b.status === 'busy' ? ' busy' : '') + (b.status === 'error' ? ' error' : '')
        + (b.confirmed ? ' confirmed' : '') + (st ? ' st-' + st : '') + (hoverId === b.id ? ' hover' : '');
      f.querySelector('.badge').textContent = parts.length > 1 ? `${i + 1}${'abcdefghij'[k] || ''}` : i + 1;
    });
  });
  for (const [id, f] of frameEls) if (!keep.has(id)) { f.remove(); frameEls.delete(id); }
}

// Typeset view: each transcribed text/math region is shown typeset in its place on the page,
// scaled to the size of the handwriting. Figures stay as ink.
function renderTypeset(list) {
  const layer = $('#typeset');
  // holding Preview (button or Space) puts the transcriptions in place of the ink, so holding and
  // releasing compares the two at a glance (dimmed ink underneath peeks out wherever the typeset
  // is narrower than the handwriting, which reads as a mistake that is not there)
  const view = previewHeld ? 'typeset' : settings.view;
  board.hiddenIds = new Set();
  board.dimIds = new Set();
  layer.innerHTML = '';
  if (view === 'ink') { board.request(); return; }
  const s = board.s;
  for (const { b, box, parts } of list) {
    const r = b.result;
    if (!r || b.status === 'busy' || !['math', 'text', 'mixed'].includes(r.kind)) continue;
    if ((parts || partsOf(b)).length > 1) continue; // spread over several places: keep the ink, it is laid out as you arranged it
    const el = document.createElement('div');
    el.className = 'ts';
    el.innerHTML = r.kind === 'math' ? tex(sourceOf(b), true) : renderMixed(sourceOf(b));
    layer.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    const bw = (box.x1 - box.x0) * s, bh = (box.y1 - box.y0) * s;
    const k = Math.max(0.3, Math.min(bw / w, bh / h, 3));
    el.style.transform = `scale(${k})`;
    el.style.left = box.x0 * s + 'px';
    el.style.top = (box.y0 * s + (bh - h * k) / 2) + 'px';
    for (const id of b.strokeIds) (view === 'typeset' ? board.hiddenIds : board.dimIds).add(id);
  }
  board.request();
}

// Panel filter: all cards, or only the regions that need a look. The cards are only hidden, not
// rebuilt, so switching is instant and nothing typed into a card is lost.
function applyCardFilter(list) {
  const cards = $('#cards');
  const only = settings.cardFilter === 'attention';
  let n = 0;
  for (const { b } of list) {
    const need = needsAttention(b);
    if (need) n++;
    cardEls.get(b.id)?.classList.toggle('filtered-out', only && !need);
  }
  const msg = cards.querySelector('.filter-msg');
  if (only && list.length && !n) {
    if (!msg) cards.insertAdjacentHTML('beforeend', '<p class="filter-msg">Nothing on this page needs attention.</p>');
  } else msg?.remove();
  for (const btn of $('#cardFilter').querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.f === (only ? 'attention' : 'all'));
    if (btn.dataset.f === 'attention') btn.textContent = n ? `Needs attention (${n})` : 'Needs attention';
  }
}

// Hold to preview: every region's transcription over the ink, for as long as the button or Space is held
function setPreview(on) {
  if (previewHeld === on) return;
  previewHeld = on;
  document.body.classList.toggle('previewing', on);
  $('#previewBtn').classList.toggle('active', on);
  renderTypeset(layoutOf());
}

// Panel and page overlays. While the pen is on the page this is held back and done when it lifts
// (board.onIdle), so incoming transcriptions never make the ink lag behind the pen.
let renderPending = false;
board.onIdle = () => { if (renderPending) { renderPending = false; renderAll(); } };

function renderAll() {
  if (board.active) { renderPending = true; return; }
  layoutVer++; // regions may have changed
  const list = layoutOf();
  const cards = $('#cards');
  const keep = new Set();
  list.forEach(({ b, parts }, i) => {
    const el = cardFor(b);
    // redraw a card only when something shown on it changed (typesetting every card is slow)
    const key = JSON.stringify([i, b.status, b.model, b.ms, b.result, b.edit, b.confirmed, b.comment, b.suggest,
      b.answer?.status, b.answer?.data, b.answer?.error, !!b.figure, b.figureBusy, b.figureError, b.error, !!b.orig,
      parts.length, settings.liveModel, settings.finalModel, b.agreement, b.pageAgree]);
    if (el.dataset.key !== key || el.contains(document.activeElement)) {
      fillCard(el, b, i + 1);
      el.dataset.key = key;
    }
    if (el.parentNode !== cards || cards.children[i] !== el) cards.insertBefore(el, cards.children[i] || null);
    keep.add(b.id);
  });
  for (const [id, el] of cardEls) if (!keep.has(id)) {
    // a card removed under the mouse never gets its mouseleave: drop the region highlight it set
    if (el.matches(':hover')) { board.highlight = null; board.request(); }
    el.remove(); cardEls.delete(id);
  }
  if (!list.length) cards.innerHTML = '<p class="dim">Nothing written on this page yet.</p>';
  else cards.querySelector('p.dim')?.remove();
  applyCardFilter(list);
  renderFrames(list);
  renderTypeset(list);
  renderAnswers(list);
  renderInterp();
  renderPhotos();
  $('#pageLabel').textContent = `${state.cur + 1} / ${state.pages.length}`;
  $('#pagePrev').disabled = state.cur === 0;
  $('#pageNext').disabled = state.cur === state.pages.length - 1;
  $('#interpret').disabled = interpBusy;
  $('#hint').hidden = state.pages.some(p => p.strokes.length || p.texts?.length || p.images?.length) || state.photos.length > 0;
}

// ----------------------------------------------------------------------------------- diagnostics
// Ctrl+Shift+D (or ⚙ → Diagnostics): what the pen sends, how long until it is drawn, and whether
// the browser is busy with other work. Updated every second while writing.
let diagTimer = 0, longTasks = [];
try {
  new PerformanceObserver(l => { for (const e of l.getEntries()) longTasks.push({ t: performance.now(), d: e.duration }); })
    .observe({ entryTypes: ['longtask'] });
} catch { /* not supported */ }
function toggleDiag() {
  let el = $('#diag');
  if (el) { el.remove(); clearInterval(diagTimer); return; }
  el = document.createElement('div');
  el.id = 'diag';
  document.body.appendChild(el);
  board.resetStats();
  longTasks = [];
  // totals since the panel was opened: write for a while, stop, then read (or screenshot) it
  const T = { t0: performance.now(), writingSec: 0, peakEvents: 0, peakPoints: 0, types: {}, lat: 0, latN: 0, latMax: 0,
    frames: 0, pageMs: 0, pageFrames: 0, gapMax: 0, gaps50: 0, pressureMax: 0 };
  // stalls between screen refreshes (also catches delays outside the app's own code)
  let lastFrame = performance.now();
  const watch = t => {
    if (!$('#diag')) return;
    const gap = t - lastFrame;
    lastFrame = t;
    if (board.active) { T.gapMax = Math.max(T.gapMax, gap); if (gap > 50) T.gaps50++; }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  const tick = () => {
    const st = board.stats;
    if (st.events) {
      T.writingSec++;
      T.peakEvents = Math.max(T.peakEvents, st.events);
      T.peakPoints = Math.max(T.peakPoints, st.points);
      for (const [k, v] of Object.entries(st.types)) T.types[k] = (T.types[k] || 0) + v;
      T.lat += st.lat; T.latN += st.latN; T.latMax = Math.max(T.latMax, st.latMax);
      T.frames += st.frames; T.pageMs += st.pageMs; T.pageFrames += st.pageFrames;
      T.pressureMax = Math.max(T.pressureMax, st.pressure || 0);
    }
    const all = state.pages.reduce((n, p) => n + p.strokes.length, 0);
    const types = Object.entries(T.types).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet';
    const lt = Math.max(0, ...longTasks.map(x => x.d));
    el.innerHTML = `<b>Diagnostics</b> — totals since opened (${Math.round((performance.now() - T.t0) / 1000)} s, writing ${T.writingSec} s) · Ctrl+Shift+D closes<br>
      pen events: ${types} · peak ${T.peakEvents} events/s, ${T.peakPoints} positions/s · max pressure ${T.pressureMax.toFixed(2)}<br>
      <b>pen → ink delay: avg ${(T.lat / Math.max(1, T.latN)).toFixed(0)} ms, max ${T.latMax.toFixed(0)} ms</b><br>
      screen stalls while writing: longest ${T.gapMax.toFixed(0)} ms, ${T.gaps50} over 50 ms · page repaints ${T.pageFrames} (avg ${(T.pageMs / Math.max(1, T.pageFrames)).toFixed(1)} ms)<br>
      browser busy (long tasks): ${longTasks.length}, longest ${lt.toFixed(0)} ms<br>
      strokes: page ${curPage().strokes.length}, session ${all} · regions ${curPage().blocks.length} · canvas ${board.canvas.width}×${board.canvas.height} px · zoom ${Math.round(board.zoom * 100)}% · ${navigator.userAgent.match(/(Chrome|Edg|Firefox)\/[\d]+/)?.[0] || ''}`;
    board.resetStats();
  };
  tick();
  diagTimer = setInterval(tick, 1000);
}

function renderCost() {
  // one entry per engine used this session, e.g. "Claude $0.0812 · 14   Mistral $0.0031 · 5"
  const money = c => (c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`);
  const parts = Object.entries(state.costBy).filter(([, c]) => c.calls)
    .map(([e, c]) => `${ENGINES[e] || e} ${money(c.cost)} · ${c.calls}`);
  const el = $('#cost');
  el.textContent = parts.join('   ');
  el.title = state.calls ? `Estimated API cost this session: $${state.cost.toFixed(4)} in ${state.calls} calls (the providers' consoles show the actual charges)` : '';
  // the same total beside the Fast / Balanced / Careful selector, where the choice is made
  const tc = $('#toolCost');
  tc.textContent = state.calls ? money(state.cost) : '';
  tc.title = el.title;
}

// ----------------------------------------------------------------------------------- photos
// HEIC/HEIF (iPhone photos): browsers on Windows cannot read them, and Windows often gives them no
// image type at all, so they are recognised by name and converted to JPEG here first.
async function heicToJpeg(file) {
  if (!window.heic2any) {
    await new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      sc.onload = res; sc.onerror = () => rej(new Error('HEIC converter not available (restart the server)'));
      document.head.appendChild(sc);
    });
  }
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(out) ? out[0] : out;
}

async function addPhoto(file) {
  if (!file) return;
  const heic = /hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
  if (!heic && !file.type.startsWith('image/')) { toast(`Not an image: ${file.name || file.type}`); return; }
  if (heic) {
    toast('Converting HEIC photo…');
    try { file = await heicToJpeg(file); } catch (err) { toast('Could not convert the HEIC photo: ' + err.message); return; }
  }
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { toast('Could not read that image'); return; }
  const max = 2000;
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const dataUrl = c.toDataURL('image/jpeg', 0.88);
  const photo = { id: ++photoSeq, dataUrl, width: c.width, height: c.height, status: 'busy', model: settings.finalModel, version: 0, result: null };
  state.photos.unshift(photo);
  settings.panel = true; applyPanel();
  runPhoto(photo);
  // photos are listed below the region cards: bring the new one into view
  toast('Photo added: reading it…');
  requestAnimationFrame(() => $('#photoHead')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function runPhoto(p, model = settings.finalModel) {
  const ver = ++p.version;
  p.status = 'busy'; p.model = model; p.error = null;
  renderPhotos();
  try {
    const r = await api({ task: 'page', model, image: p.dataUrl.split(',')[1], mediaType: 'image/jpeg', width: p.width, height: p.height });
    if (p.version !== ver) return;
    Object.assign(p, { result: r.data, ms: r.ms, status: 'ok' });
  } catch (err) {
    if (p.version !== ver) return;
    Object.assign(p, { status: 'error', error: err.message });
  }
  renderPhotos();
}

function photoItemsHtml(items) {
  return items.map(it => {
    if (it.type === 'math') return tex(it.content, true);
    if (it.type === 'heading') return `<h4>${renderMixed(it.content)}</h4>`;
    if (it.type === 'figure') return `<p class="muted">Figure: ${renderMixed(it.content)}</p>`;
    return `<p>${renderMixed(it.content)}</p>`;
  }).join('');
}

function photoLatex(p) {
  if (!p.result) return '';
  return p.result.items.map(it => {
    if (it.type === 'math') return `\\[\n${it.content}\n\\]`;
    if (it.type === 'heading') return `\\subsection*{${it.content}}`;
    if (it.type === 'figure') return `% figure: ${it.content}`;
    return it.content;
  }).join('\n\n');
}

function renderPhotos() {
  const box = $('#photos');
  $('#photoHead').hidden = !state.photos.length;
  box.innerHTML = '';
  for (const p of state.photos) {
    const el = document.createElement('div');
    el.className = 'card';
    const other = ({
      mistral: p.model === 'mistral-medium' ? 'mistral-large' : 'mistral-medium',
      openai: p.model === 'gpt-astra' ? 'gpt-sol' : 'gpt-astra',
      claude: p.model === 'opus' ? 'sonnet' : 'opus',
    })[engineOf(p.model)];
    el.innerHTML = `
      <div class="card-head"><span class="kind">photo</span><span class="meta">${p.status === 'busy' ? `<span class="busy">${MODELS[p.model]} …</span>` : p.status === 'ok' ? `${MODELS[p.model]} · ${p.ms} ms` : ''}</span></div>
      <img class="photo-thumb" src="${p.dataUrl}" alt="photo">
      <div class="render">${p.result ? photoItemsHtml(p.result.items) : p.status === 'busy' ? '<span class="muted">transcribing…</span>' : ''}</div>
      ${p.error ? `<div class="error-msg">${esc(p.error)}</div>` : ''}
      <ul class="uncertain">${(p.result?.uncertain || []).map(u => `<li>${esc(u)}</li>`).join('')}</ul>
      <div class="actions">
        ${p.result ? '<button data-act="latex">Copy LaTeX</button>' : ''}
        <button data-act="rerun">↻ ${MODELS[other]}</button>
        <button data-act="remove">Remove</button>
      </div>`;
    el.querySelector('.photo-thumb').addEventListener('click', e => e.target.classList.toggle('big'));
    el.addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'latex') copyText(photoLatex(p), 'LaTeX copied');
      if (act === 'rerun') runPhoto(p, other);
      if (act === 'remove') { state.photos = state.photos.filter(x => x !== p); renderAll(); }
    });
    box.appendChild(el);
  }
}

// ----------------------------------------------------------------------------------- export
function blockLatex(b) {
  const r = b.result;
  if (!r) return '';
  let note = b.comment ? `% note: ${oneLine(b.comment, 300)}\n` : '';
  const v = answerValue(b);
  if (v && v.latex) note += `% answer (${v.label}): ${v.latex}\n`;
  if (r.kind === 'math') return `${note}\\[\n${sourceOf(b)}\n\\]`;
  if (r.kind === 'text' || r.kind === 'mixed') return note + sourceOf(b);
  if (r.kind === 'figure') return note + (b.figure ? b.figure.tikz : `% figure: ${sourceOf(b)}`);
  return '';
}
function blockMarkdown(b) {
  const r = b.result;
  if (!r) return '';
  const note = b.comment ? `\n\n> Note: ${b.comment}` : '';
  if (r.kind === 'math') return `$$\n${sourceOf(b)}\n$$` + note;
  if (r.kind === 'figure') return `*Figure: ${r.text}*` + note;
  return r.kind === 'empty' ? '' : sourceOf(b) + note;
}

// typed text boxes, top to bottom; plainText writes typeset maths as $...$
const typedTexts = pg => (pg.texts || []).filter(t => plainText(t.html).trim()).sort((a, c) => a.y - c.y || a.x - c.x).map(t => plainText(t.html));
// LaTeX: escape the text, keep the $...$ maths as it is
const TEX_ESC = { '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', 'µ': '\\textmu{}' };
const texText = str => str.split(/(\$[^$]*\$)/)
  .map((p, i) => (i % 2 ? p : p.replace(/[\\&%#_{}~^µ]/g, c => TEX_ESC[c] || '\\' + c))).join('').replace(/\n/g, '\\\\\n');
function allLatex() {
  const out = [];
  state.pages.forEach((pg, i) => {
    const parts = [...sortedBlocks(pg).map(({ b }) => blockLatex(b)), ...typedTexts(pg).map(t => `% typed\n${texText(t)}`)].filter(Boolean);
    if (parts.length) out.push(`% ---- page ${i + 1} ----\n\n` + parts.join('\n\n'));
  });
  state.photos.slice().reverse().forEach((p, i) => { if (p.result) out.push(`% ---- photo ${i + 1} ----\n\n` + photoLatex(p)); });
  return out.join('\n\n');
}

function allMarkdown() {
  const out = [];
  state.pages.forEach((pg, i) => {
    const parts = [...sortedBlocks(pg).map(({ b }) => blockMarkdown(b)), ...typedTexts(pg).map(t => `> ${t.replace(/\n/g, '\n> ')}`)].filter(Boolean);
    if (parts.length) out.push(`## Page ${i + 1}\n\n` + parts.join('\n\n'));
    if (pg.interp?.data) out.push(`### Page ${i + 1} - interpretation\n\n${pg.interp.data.document}`);
  });
  state.photos.slice().reverse().forEach((p, i) => {
    if (!p.result) return;
    const body = p.result.items.map(it => it.type === 'math' ? `$$\n${it.content}\n$$` : it.type === 'heading' ? `### ${it.content}` : it.type === 'figure' ? `*Figure: ${it.content}*` : it.content).join('\n\n');
    out.push(`## Photo ${i + 1}\n\n` + body);
  });
  return out.join('\n\n');
}

// print: each page as an ink image on its own sheet, followed by its transcription
// the answers of a page ("= ?" results), with their place in page units, as renderAnswers puts
// them on the board: inside a drawn answer box, or after the last part of the question
function answerSpots(p) {
  const out = [];
  for (const b of p.blocks || []) {
    try {
      const v = answerValue(b);
      if (!v?.latex || v.cls === 'err') continue;
      const parts = partsOf(b, p);
      if (!parts.length) continue;
      const box = parts[parts.length - 1].box, abox = answerBoxOf(b, p);
      if (abox) {
        const size = Math.max(18, Math.min(56, (abox.y1 - abox.y0) * 0.5));
        out.push({ latex: v.latex, cls: v.cls, size, x: abox.x0 + 8, y: abox.y0 + ((abox.y1 - abox.y0) - size * 1.25) / 2 });
      } else {
        const h = box.y1 - box.y0, size = Math.max(20, Math.min(60, h * 0.6));
        out.push({ latex: v.latex, cls: v.cls, size, x: box.x1 + 10, y: box.y0 + (h - size * 1.25) / 2 });
      }
    } catch { /* a block of a saved page that cannot be placed: leave it out */ }
  }
  return out;
}

// Print / PDF: every page as it looks (slides and figures, ink, typed text, answers), scaled to the
// paper, followed by its transcription. Built again before each print.
function printPageHtml(pg, W, H, k) {
  const pct = (v, of) => (100 * v / of).toFixed(3) + '%';
  const imgs = (pg.images || []).filter(im => !im.shot && /^(https:|data:image\/)/.test(im.src))
    .sort((a, b) => (b.bg ? 1 : 0) - (a.bg ? 1 : 0))
    .map(im => `<img class="pp-img" src="${esc(im.src)}" style="left:${pct(im.x, W)};top:${pct(im.y, H)};width:${pct(im.w, W)};height:${pct(im.h, H)}" alt="">`).join('');
  const panes = (pg.panes || []).map(pn => `<div class="pp-pane" style="left:${pct(pn.x, W)};top:${pct(pn.y, H)};width:${pct(pn.w, W)};height:${pct(pn.h, H)}">HTML: ${esc(pn.name || 'interactive page')}</div>`).join('');
  const ink = pg.strokes.length ? `<img class="pp-ink" src="${renderPageImage(pg.strokes, W, H, THEMES.white.palette, 2, true)}" alt="">` : '';
  const texts = (pg.texts || []).map(t => `<div class="pp-tx" style="${esc(textLayer.boxCss({ ...t, color: t.color === 'auto' ? '#1b1b1b' : t.color }))}">${sanitize(t.html)}</div>`).join('');
  const answers = answerSpots(pg).map(a => `<div class="pp-tx pp-ans ${a.cls}" style="left:${a.x}px;top:${a.y}px;font-size:${a.size}px"><span class="tx-math" data-tex="${esc(a.latex)}"></span></div>`).join('');
  return `<div class="pp" style="height:${(H * k).toFixed(1)}px;width:${(W * k).toFixed(1)}px"><div class="pp-in" style="width:${W}px;height:${H}px;transform:scale(${k})">${imgs}${panes}${ink}<div class="pp-texts">${texts}${answers}</div></div></div>`;
}
function buildPrint() {
  const area = $('#printArea');
  const [W, H] = PAGE[settings.orientation];
  // the printable width of A4 at 96 px/inch with ~1 cm margins: 277 mm landscape, 190 mm portrait
  const k = (settings.orientation === 'portrait' ? 718 : 1047) / W;
  const parts = [];
  state.pages.forEach((pg, i) => {
    if (!pg.strokes.length && !(pg.images || []).length && !(pg.texts || []).length) return;
    parts.push(printPageHtml(pg, W, H, k));
    const items = sortedBlocks(pg).map(({ b }, k) => b.result && b.result.kind !== 'empty'
      ? `<div class="item"><span class="num">(${k + 1})</span> ${blockContentHtml(b)}${answerHtml(b, false)}${b.comment ? `<div class="num">Note: ${esc(b.comment)}</div>` : ''}</div>` : '').join('');
    const doc = pg.interp?.data ? `<h2>Page ${i + 1}: interpretation</h2><div class="item">${renderDoc(pg.interp.data.document)}</div>` : '';
    parts.push(`<div class="tx"><h2>Page ${i + 1}: transcription</h2>${items}${doc}</div>`);
  });
  // landscape and 16:9 pages print on landscape paper
  const paper = settings.orientation === 'portrait' ? 'portrait' : 'landscape';
  area.innerHTML = `<style>@page { size: A4 ${paper}; margin: 10mm; }</style>` + parts.join('');
  fillMath(area);
  printBuilt = performance.now();
}
let printBuilt = 0;
// the Print button: build, wait until the slides and figures have loaded, then print
async function printNow() {
  buildPrint();
  await Promise.all([...$('#printArea').querySelectorAll('img')].map(im => im.decode().catch(() => {})));
  window.print();
}
window.addEventListener('beforeprint', () => { if (performance.now() - printBuilt > 2000) buildPrint(); }); // Ctrl+P / the browser's menu

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

function serialize(withPhotos) {
  const r1 = v => Math.round(v * 10) / 10;
  return {
    app: 'ink2latex', version: 2, coords: 'page', orientation: settings.orientation, saved: new Date().toISOString(),
    pages: state.pages.map(p => ({
      uid: p.uid,
      strokes: p.strokes.map(s => ({ id: s.id, size: s.size, color: s.color, pen: s.pen, shape: s.shape, ...(s.alpha ? { alpha: s.alpha } : {}), ...(s.dash ? { dash: true } : {}), pts: s.pts.map(([x, y, pr]) => [r1(x), r1(y), Math.round(pr * 100) / 100]) })),
      blocks: p.blocks.map(b => ({ id: b.id, strokeIds: b.strokeIds, sig: b.sig, status: b.status === 'busy' ? 'stale' : b.status, model: b.model, result: b.result, edit: b.edit, confirmed: b.confirmed, figure: b.figure, ms: b.ms, comment: b.comment, suggest: b.suggest, orig: b.orig || null, agreement: b.agreement || null, pageAgree: b.pageAgree ?? null, pieces: isGroup(b) ? piecesOf(b) : null, answer: b.answer && b.answer.status !== 'busy' ? b.answer : null })),
      interp: p.interp && !p.interp.error ? p.interp : null,
      texts: p.texts || [],
      images: p.images || [],
      panes: p.panes || [],
      hidden: !!p.hidden,
    })),
    photos: withPhotos ? state.photos.map(p => ({ ...p, status: p.status === 'busy' ? 'error' : p.status })) : [],
    cost: state.cost, calls: state.calls, costBy: state.costBy,
  };
}

function restore(data) {
  if (!data || data.app !== 'ink2latex') throw new Error('not an ink2latex session');
  if (data.orientation) { settings.orientation = data.orientation; $('#orientation').value = data.orientation; board.setPageSize(data.orientation); }
  if (data.coords !== 'page') {
    // sessions from v1 stored screen pixels: shrink to fit the page width if needed
    const maxX = Math.max(0, ...data.pages.flatMap(p => p.strokes.flatMap(s => s.pts.map(q => q[0]))));
    const f = maxX > board.pageW * 0.97 ? (board.pageW * 0.95) / maxX : 1;
    if (f < 1) for (const p of data.pages) for (const s of p.strokes) { s.size *= f; s.pts = s.pts.map(([x, y, pr]) => [x * f, y * f, pr]); }
  }
  state.pages = data.pages.map(p => ({
    uid: p.uid || crypto.randomUUID(),
    strokes: p.strokes, undo: [], redo: [], interp: p.interp || null,
    blocks: p.blocks.map(b => ({ ...newBlock(), ...b, id: b.id })),
    texts: p.texts || [],
    images: p.images || [],
    panes: p.panes || [],
    hidden: !!p.hidden,
  }));
  if (!state.pages.length) state.pages = [newPage()];
  state.photos = data.photos || [];
  state.cost = data.cost || 0; state.calls = data.calls || 0;
  // older sessions only have the total: count it as Claude (the only engine then)
  state.costBy = data.costBy || (state.calls ? { claude: { cost: state.cost, calls: state.calls } } : {});
  state.cur = 0;
  blockSeq = Math.max(0, ...state.pages.flatMap(p => p.blocks.map(b => b.id)));
  photoSeq = Math.max(0, ...state.photos.map(p => p.id));
  for (const el of cardEls.values()) el.remove();
  cardEls.clear();
  board.setPage(curPage());
  renderAll(); renderCost();
}

// Autosave a moment after changes, never while the pen is on the page or has only just lifted
// (saving a big session takes a moment, and the pen must not wait for it).
let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
  send?.changed();
  student?.changed();
}
function saveNow() {
  if (board.active || performance.now() - (board.lastUp || 0) < 1200) { saveTimer = setTimeout(saveNow, 800); return; }
  const data = serialize(false);
  idb.set('session', data)
    .then(() => { try { localStorage.removeItem('ink2latex.session'); } catch { /* ignore */ } })
    .catch(() => store.set('ink2latex.session', data));
}

// ----------------------------------------------------------------------------------- one board per lecture
// The board on screen belongs to settings.boardLecture: a lecture id, or null for the local board that
// is not tied to a lecture. Switching lecture stores this board under 'board:<id | local>' in IndexedDB
// and opens the other one: from this PC, or from the cloud copy (send.js) when that is newer or the
// only one. 'session' always holds the board on screen, as before.
const boardKey = id => 'board:' + (id || 'local');
async function switchBoard(id, { keep = false, fetchCloud = null } = {}) {
  const from = settings.boardLecture || null;
  id = id || null;
  if (from === id) return false;
  clearTimeout(regroupTimer);
  regroup();
  clearErrorMarks(false);
  await idb.set(boardKey(from), serialize(false)).catch(() => {});
  settings.boardLecture = id;
  saveSettings();
  if (!keep) {
    let next = await idb.get(boardKey(id)).catch(() => null);
    const cloud = id && fetchCloud ? await fetchCloud(id).catch(() => null) : null;
    if (cloud && (!next || (cloud.saved || '') > (next.saved || ''))) next = cloud;
    restore(next || { app: 'ink2latex', coords: 'page', orientation: settings.orientation, pages: [] });
  }
  saveNow();
  assign?.sync();
  return true;
}

// A page with its ink turned into a picture (transparent PNG, twice the page size) over its slides
// and figures, and its text boxes locked: how an assignment gives a task (students write on top but
// cannot erase it) and how a hand-in is shown for review. p: a page on the board or a saved one.
// online: upload the picture (lecturer; else it stays a data: URL); theme: the colours of the ink.
async function flattenPage(p, { online = false, theme = settings.board, orientation = settings.orientation } = {}) {
  const [W, H] = PAGE[orientation] || PAGE.portrait;
  const q = copyPage({ blocks: [], texts: [], images: [], panes: [], ...p, strokes: [] });
  q.blocks = []; q.interp = null; q.hidden = false;
  q.texts = q.texts.map(t => ({ ...t, lock: true }));
  q.images = q.images.map(im => ({ ...im, lock: true })); // slides and figures stay too (no handles, not cleared)
  // the answers ("= ?" results) are drawn by the board from the regions, which do not survive: keep them as text
  for (const a of answerSpots(p)) {
    q.texts.push({ id: 't' + newImageId(), x: Math.round(a.x), y: Math.round(a.y), w: null, font: 'serif', size: Math.round(a.size), color: a.cls === 'ai' ? 'blue' : 'green', html: `<span class="tx-math" contenteditable="false" data-tex="${esc(a.latex)}"></span>`, lock: true });
  }
  if (p.strokes?.length) {
    const k = 2, c = document.createElement('canvas');
    c.width = W * k; c.height = H * k;
    const g = c.getContext('2d');
    g.setTransform(k, 0, 0, k, 0, 0);
    const pal = (THEMES[theme] || THEMES.white).palette;
    for (const s of p.strokes) paintStroke(g, { ...s, _path: null }, pal[s.color] || s.color || pal.auto);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const src = (online && await upload(blob)) || await blobToDataUrl(blob);
    q.images.push({ id: newImageId(), src, x: 0, y: 0, w: W, h: H, lock: true });
  }
  return q;
}
// A board rebuilt from the pages that were sent to the students (when there is no full copy): ink,
// regions and their transcriptions come back; answers and interpretations are worked out again.
function fromSentPages(rows) {
  if (!rows?.length) return null;
  return {
    app: 'ink2latex', version: 2, coords: 'page', orientation: rows[0].orientation || settings.orientation,
    saved: rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), ''),
    pages: rows.map(r => ({
      uid: crypto.randomUUID(),
      strokes: r.strokes || [],
      blocks: (r.blocks || []).map(b => ({
        id: b.id, strokeIds: b.strokeIds, result: b.result, edit: b.edit ?? undefined, confirmed: b.confirmed,
        status: b.result ? 'done' : 'stale', sig: b.result ? sigOf(b.strokeIds) : undefined,
      })),
      interp: null,
      texts: r.texts || [],
      images: r.images || [],
      panes: r.panes || [],
    })),
  };
}
// the board shown after an update from before boards were tied to lectures: it belongs to the lecture chosen in Send
if (settings.boardLecture === undefined) { settings.boardLecture = settings.sendLecture?.id || null; saveSettings(); }

// ----------------------------------------------------------------------------------- send mode
// What students receive for one page: the ink, the transcriptions and answers, and the
// interpretation's document (possible errors stay with the lecturer).
function pagePayload(p) {
  const r1 = v => Math.round(v * 10) / 10;
  return {
    strokes: p.strokes.map(s => ({ id: s.id, size: r1(s.size), color: s.color, pen: s.pen, shape: s.shape, ...(s.alpha ? { alpha: s.alpha } : {}), ...(s.dash ? { dash: true } : {}),
      pts: s.pts.map(([x, y, pr]) => [r1(x), r1(y), Math.round(pr * 100) / 100]) })),
    blocks: p.blocks.map(b => {
      const v = answerValue(b);
      // where the answer sits on the board, so the students see it in the same place: inside the
      // answer box, or else right after the last part of the question (page units)
      let at = null;
      if (v && v.latex) {
        const abox = answerBoxOf(b, p), parts = abox ? null : partsOf(b, p);
        const r = x => ({ x0: Math.round(x.x0), y0: Math.round(x.y0), x1: Math.round(x.x1), y1: Math.round(x.y1) });
        at = abox ? { box: r(abox) } : parts?.length ? { after: r(parts[parts.length - 1].box) } : null;
      }
      return {
        id: b.id, strokeIds: b.strokeIds, status: b.status, confirmed: !!b.confirmed,
        result: b.result ? { kind: b.result.kind, latex: b.result.latex, text: b.result.text } : null,
        edit: b.edit ?? null,
        answer: v && v.latex ? { latex: v.latex, label: v.label, cls: v.cls, at } : null,
      };
    }),
    interp: p.interp?.data ? { summary: p.interp.data.summary, document: p.interp.data.document } : null,
    texts: p.texts || [], // typed text boxes (the viewer sanitizes them again before showing)
    images: publicImages(p.images), // slides and figures (uploaded ones only), and snapshots of HTML panes
    panes: publicPanes(p.panes), // HTML panes students run themselves ("their own copy")
  };
}

// ----------------------------------------------------------------------------------- toolbar
function setTool(t) {
  if (htmlInteract) setInteract(false);
  if (t !== 'lasso') board.clearSelection();
  board.tool = t;
  textLayer.setActive(t === 'text');
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  applyCursor();
  renderFigHandles();
  fullscreen?.sync();
  board.request();
}

// The pointer while writing: a pencil in the ink colour, its tip at the pen and its back end towards
// the upper right (about 1:30, as the pen is held).
function pencilCursor(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
    <g transform="translate(2 32) rotate(-45)">
      <path d="M0 0 L8 -4.5 L8 4.5 Z" fill="#ecc9a0" stroke="#333" stroke-width="1" stroke-linejoin="round"/>
      <path d="M0 0 L3.2 -1.8 L3.2 1.8 Z" fill="${color}" stroke="${color}" stroke-width=".6"/>
      <rect x="8" y="-4.5" width="21" height="9" fill="#f2c230" stroke="#333" stroke-width="1"/>
      <line x1="8" y1="0" x2="29" y2="0" stroke="#c99600" stroke-width="1"/>
      <rect x="29" y="-4.5" width="3.5" height="9" fill="#b8b8b8" stroke="#333" stroke-width="1"/>
      <rect x="32.5" y="-4.5" width="5" height="9" rx="1.8" fill="#f28b9b" stroke="#333" stroke-width="1"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 2 32, default`;
}
// Pen: the pencil (precise, for positioning and writing). Laser: a red spot drawn by the board.
// Eraser: its tinted circle, drawn by the board. Select: cell.
function applyCursor() {
  const pal = THEMES[settings.board].palette;
  const t = board.tool;
  board.baseCursor = t === 'lasso' ? 'cell' : t === 'pen' ? pencilCursor(pal[board.color] || pal.auto) : 'none';
  // while the pen touches the screen Windows hides the pointer: the board draws this pencil itself
  const img = new Image();
  img.src = board.baseCursor.startsWith('url') ? board.baseCursor.match(/url\("(.*?)"\)/)[1] : '';
  board.pencilImg = t === 'pen' ? img : null;
  $('#board').style.cursor = board.baseCursor;
  board.requestLive();
}
// P, or Shift pressed and released on its own: switch between pen and laser (not while typing)
const togglePenLaser = () => setTool(board.tool === 'pen' ? 'laser' : 'pen');
{
  let shiftAlone = false;
  const typing = e => e.target.isContentEditable || (e.target.closest && e.target.closest('textarea, input, select'));
  document.addEventListener('keydown', e => { shiftAlone = e.key === 'Shift' && !e.repeat && !typing(e) && !e.ctrlKey && !e.altKey && !e.metaKey; });
  document.addEventListener('keyup', e => { if (e.key === 'Shift' && shiftAlone && !typing(e)) togglePenLaser(); shiftAlone = false; });
  document.addEventListener('pointerdown', () => { shiftAlone = false; }, true); // Shift + click is not a switch
}
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));

document.querySelectorAll('.swatch').forEach(b => b.addEventListener('click', () => {
  board.color = b.dataset.color;
  document.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x === b));
  setTool('pen');
}));

const sizeEl = $('#size');
if (settings.penSize == null) settings.penSize = (settings.size ?? 3) + 1.5; // older setting stored an offset
sizeEl.value = settings.penSize;
const applySize = () => {
  board.size = settings.penSize = Number(sizeEl.value);
  sizeEl.title = `Pen width ${settings.penSize}${settings.penSize <= 1 ? ' (hairline)' : ''}`;
  saveSettings();
};
sizeEl.addEventListener('input', applySize);
applySize();

// ----------------------------------------------------------------------------------- pen styles
// Hold C: the pen palette (8 colours, see-through, dashed, three widths) under the pen; change the
// style, let go of C, write on. Hold S: store the current pen in one of five slots (a short tap of
// S is still the Select tool). Hold R: recall one of the five. A quick tap of C or R leaves the
// palette open until a choice, Esc or a click elsewhere. While a slot palette is open, 1-5 pick.
const PEN_COLORS = ['auto', 'blue', 'red', 'green', 'orange', 'purple', 'teal', 'yellow'];
const PEN_COLOR_NAMES = { auto: 'Ink', blue: 'Blue', red: 'Red', green: 'Green', orange: 'Orange', purple: 'Purple', teal: 'Teal', yellow: 'Yellow' };
const PEN_WIDTHS = [['Fine', 2], ['Medium', 4.5], ['Bold', 9]];
const SEE_THROUGH = 0.4;
const penStyle = () => ({ color: board.color, size: board.size, alpha: board.alpha, dash: board.dash });
function applyPenStyle(st) {
  board.color = st.color;
  board.alpha = st.alpha && st.alpha < 1 ? st.alpha : 1;
  board.dash = !!st.dash;
  sizeEl.value = st.size; applySize();
  document.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', x.dataset.color === st.color));
  if (board.tool !== 'pen') setTool('pen'); else applyCursor();
}
// a short curve drawn in a pen style, on the board's own colour so the ink looks as it will
function penSample(st, w = 132, h = 26) {
  const pal = THEMES[settings.board].palette;
  const col = pal[st.color] || st.color || pal.auto;
  const sw = Math.max(1, Math.min(st.size * 1.1, 13));
  const dash = st.dash ? ` stroke-dasharray="${(sw * 2.2 + 2).toFixed(1)} ${(sw * 1.8 + 3).toFixed(1)}"` : '';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="M9 ${h / 2 + 4} C ${w * 0.32} ${h / 2 - 9}, ${w * 0.58} ${h / 2 + 11}, ${w - 9} ${h / 2 - 4}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"${dash} opacity="${st.alpha || 1}"/></svg>`;
}
const slots = () => (settings.penSlots ||= [null, null, null, null, null]);
let penPop = null;         // the open palette element
let penKey = null;         // {key, mode, t, opened, used, timer} while C / S / R is held
let lastPointer = null;    // last pointer position on screen, to open the palette where the pen is
document.addEventListener('pointermove', e => { lastPointer = [e.clientX, e.clientY]; }, true);

function penPopHtml(mode) {
  const bg = THEMES[settings.board].bg;
  const cur = penStyle();
  if (mode === 'style') {
    return `<div class="pp-title">Pen <span class="dim">· let go of C to write</span></div>
      <div class="pp-sample" style="background:${bg}">${penSample(cur, 220, 30)}</div>
      <div class="pp-colors">${PEN_COLORS.map(c => `<button data-pc="${c}" class="pp-col${c === cur.color ? ' on' : ''}" title="${PEN_COLOR_NAMES[c]}" style="--c:${THEMES[settings.board].palette[c]}"></button>`).join('')}</div>
      <div class="pp-row"><button data-pt="alpha" class="${cur.alpha < 1 ? 'on' : ''}" title="See-through ink, like a highlighter">See-through</button>
        <button data-pt="dash" class="${cur.dash ? 'on' : ''}" title="Dashed line">Dashed</button></div>
      <div class="pp-row">${PEN_WIDTHS.map(([n, w]) => `<button data-pw="${w}" class="pp-w${Math.abs(cur.size - w) < 0.01 ? ' on' : ''}" title="${n}" style="background:${bg}">${penSample({ ...cur, size: w }, 64, 22)}</button>`).join('')}</div>`;
  }
  const store = mode === 'store';
  return `<div class="pp-title">${store ? 'Store the current pen' : 'Recall a pen'} <span class="dim">· 1-5 or click</span></div>
    ${store ? `<div class="pp-sample" style="background:${bg}">${penSample(cur, 220, 30)}</div>` : ''}
    <div class="pp-slots">${slots().map((st, i) => `<button data-slot="${i}" class="pp-slot${st ? '' : ' empty'}" title="${store ? (st ? 'Overwrite slot ' : 'Store in slot ') + (i + 1) : st ? 'Use slot ' + (i + 1) : 'Slot ' + (i + 1) + ' is empty'}" style="background:${bg}">
      <span class="pp-n">${i + 1}</span>${st ? penSample(st, 150, 24) : '<span class="pp-empty">empty</span>'}</button>`).join('')}</div>`;
}
function openPenPop(mode) {
  closePenPop();
  penPop = document.createElement('div');
  penPop.id = 'penPop';
  penPop.dataset.mode = mode;
  penPop.innerHTML = penPopHtml(mode);
  document.body.appendChild(penPop);
  // under the pen if it is over the page, else in the middle of the board, and always on screen
  const r = penPop.getBoundingClientRect();
  const wr = $('#boardWrap').getBoundingClientRect();
  const [px, py] = lastPointer || [wr.left + wr.width / 2, wr.top + wr.height / 2];
  penPop.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, px - r.width / 2)) + 'px';
  penPop.style.top = Math.max(8, Math.min(innerHeight - r.height - 8, py - r.height - 24)) + 'px';
  // pointerdown, not click: a pen tap acts at once, and the page underneath never sees it
  penPop.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); penPopPick(e.target.closest('button')); });
}
function closePenPop() { penPop?.remove(); penPop = null; }
function refreshPenPop() { if (penPop) penPop.innerHTML = penPopHtml(penPop.dataset.mode); }
function penPopPick(btn) {
  if (!btn || !penPop) return;
  const mode = penPop.dataset.mode;
  if (penKey) penKey.used = true;
  const d = btn.dataset;
  if (mode === 'style') {
    const st = penStyle();
    if (d.pc) st.color = d.pc;
    if (d.pt === 'alpha') st.alpha = st.alpha < 1 ? 1 : SEE_THROUGH;
    if (d.pt === 'dash') st.dash = !st.dash;
    if (d.pw) st.size = Number(d.pw);
    applyPenStyle(st);
    refreshPenPop();
    return;
  }
  if (d.slot != null) chooseSlot(Number(d.slot));
}
function chooseSlot(i) {
  if (!penPop) return;
  if (penKey) penKey.used = true;
  if (penPop.dataset.mode === 'store') {
    slots()[i] = penStyle(); saveSettings();
    toast(`Pen stored in slot ${i + 1}`);
  } else {
    const st = slots()[i];
    if (!st) { toast(`Slot ${i + 1} is empty: hold S to store a pen there`); return; }
    applyPenStyle(st);
  }
  closePenPop();
}
// key down: open now (C, R) or after a moment (S, whose tap is still the Select tool)
function penKeyDown(key, mode, delay = 0) {
  if (penKey?.key === key) return; // key repeat
  clearTimeout(penKey?.timer);
  penKey = { key, mode, t: performance.now(), opened: false, used: false, timer: 0 };
  const open = () => { if (penKey?.key === key) { penKey.opened = true; openPenPop(mode); } };
  if (delay) penKey.timer = setTimeout(open, delay); else open();
}
function penKeyUp(key) {
  if (penKey?.key !== key) return false;
  const h = penKey; penKey = null;
  clearTimeout(h.timer);
  if (!h.opened) { if (h.mode === 'store') setTool('lasso'); return true; } // a tap of S: Select, as before
  const tap = performance.now() - h.t < 250 && !h.used;
  if (tap && h.mode !== 'store') return true; // a quick tap leaves the palette open
  closePenPop();
  return true;
}
document.addEventListener('keyup', e => { if (penKeyUp(e.key.toLowerCase())) e.preventDefault(); });
window.addEventListener('blur', () => { if (penKey) { clearTimeout(penKey.timer); penKey = null; closePenPop(); } });
// an open palette (left open by a tap) closes on a press anywhere else
document.addEventListener('pointerdown', e => { if (penPop && !penPop.contains(e.target)) closePenPop(); }, true);

// K: every keyboard shortcut, as a splash; K again, Esc or a click closes it
const SHORTCUTS = [
  ['Writing', [['P', 'Pen / laser pointer (or Shift pressed alone)'], ['E', 'Eraser on / off'], ['T', 'Text box'], ['S or G', 'Select (lasso)'],
    ['C (hold)', 'Pen palette: 8 colours, see-through, dashed, 3 widths. Let go to write on'],
    ['S (hold)', 'Store the current pen in one of 5 slots'], ['R (hold)', 'Recall one of the 5 stored pens'], ['1-5', 'Pick a slot while its palette is open']]],
  ['Page', [['Space (hold)', 'Preview: the transcriptions in place of the ink'], ['B', 'Region boxes: all / current / off'],
    ['I', 'Use the HTML on this page / write on it'], ['← → / PgUp PgDn', 'Previous / next page'], ['Enter', 'Answer the question under the pen']]],
  ['Editing', [['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+G', 'Group the selection'], ['Ctrl+Shift+G', 'Ungroup'], ['Delete', 'Delete the selection'], ['Esc', 'Deselect, close a popup']]],
  ['Other', [['K', 'This list'], ['Ctrl+P', 'Print'], ['Ctrl+Shift+D', 'Diagnostics']]],
];
function toggleKeys() {
  if ($('#keysDlg')) { $('#keysDlg').remove(); return; }
  const d = document.createElement('div');
  d.id = 'keysDlg';
  d.innerHTML = `<div class="keys-box" role="dialog" aria-label="Keyboard shortcuts"><strong>Keyboard shortcuts</strong>
    <div class="keys-cols">${SHORTCUTS.map(([h, rows]) => `<div><h4>${h}</h4>${rows.map(([k, t]) => `<div class="keys-row"><kbd>${esc(k)}</kbd><span>${esc(t)}</span></div>`).join('')}</div>`).join('')}</div>
    <div class="dim small">K, Esc or a click closes this</div></div>`;
  document.body.appendChild(d);
  d.addEventListener('pointerdown', () => d.remove());
}

$('#undo').addEventListener('click', () => board.undo());
$('#redo').addEventListener('click', () => board.redo());
$('#clear').addEventListener('click', () => board.clear());

const snapEl = $('#snap');
snapEl.checked = settings.snap; board.snap = settings.snap;
snapEl.addEventListener('change', () => { board.snap = settings.snap = snapEl.checked; saveSettings(); });

function applyBoard() {
  document.body.dataset.board = settings.board;
  const th = THEMES[settings.board];
  board.setTheme(th.bg, th.palette);
  textLayer.render(); // 'auto' and palette colours follow the board
  if (typeof applyCursor === 'function' && board.tool) applyCursor();
  $('#boardToggle').textContent = settings.board === 'white' ? 'Blackboard' : 'Whiteboard';
}
$('#boardToggle').addEventListener('click', () => { settings.board = settings.board === 'white' ? 'black' : 'white'; saveSettings(); applyBoard(); });
applyBoard();

// zoom: < 100% shows the page smaller, giving more room for the same hand movements
board.onZoom = z => { $('#zoomReset').textContent = Math.round(z * 100) + '%'; settings.zoom = z; saveSettings(); };
$('#zoomOut').addEventListener('click', () => board.setZoom(board.zoom / 1.2));
$('#zoomIn').addEventListener('click', () => board.setZoom(board.zoom * 1.2));
$('#zoomReset').addEventListener('click', () => board.setZoom(1));
board.setZoom(settings.zoom || 1);
$('#fitPage').addEventListener('click', () => {
  if (board.fitToPage()) { renderAll(); toast('Scaled to fit the page (Ctrl+Z undoes)'); }
  else toast('Everything already fits on the page');
});

// region boxes: all shown, only the one under the pen/mouse, or none (a clean page); B cycles
const BOX_MODES = { always: '▢ All', hover: '▢ Current', none: '▢ Off' };
function applyBoxes() {
  const mode = BOX_MODES[settings.boxes] ? settings.boxes : 'always';
  document.body.classList.toggle('frames-hover', mode === 'hover');
  document.body.classList.toggle('frames-none', mode === 'none');
  $('#boxesBtn').classList.toggle('active', mode === 'always');
  $('#boxesBtn').textContent = BOX_MODES[mode];
}
const toggleBoxes = () => {
  const order = ['always', 'hover', 'none'];
  settings.boxes = order[(order.indexOf(settings.boxes) + 1) % order.length];
  saveSettings();
  applyBoxes();
  toast({ always: 'Boxes: all', hover: 'Boxes: only the one under the pen', none: 'Boxes: off (clean page)' }[settings.boxes]);
};
$('#boxesBtn').addEventListener('click', toggleBoxes);
applyBoxes();

// View menu: ink / typeset / both, and whether the students' placed comments and questions show on the board
const viewMenu = $('#viewMenu');
for (const r of viewMenu.querySelectorAll('[name=view]')) r.checked = r.value === settings.view;
$('#showStudent').checked = settings.showStudent !== false;
$('#viewBtn').addEventListener('click', e => { e.stopPropagation(); viewMenu.hidden = !viewMenu.hidden; keepOnScreen(viewMenu); });
viewMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { viewMenu.hidden = true; });
viewMenu.addEventListener('change', e => {
  if (e.target.name === 'view') { settings.view = e.target.value; saveSettings(); renderAll(); }
  if (e.target.id === 'showStudent') { settings.showStudent = e.target.checked; saveSettings(); send?.renderDots(); }
});

for (const id of ['autoInterp', 'autoAccept', 'autoEval', 'autoMerge', 'readContext', 'lineGroup', 'twoReadings', 'pageCheck']) {
  const el = $('#' + id);
  el.checked = settings[id];
  el.addEventListener('change', () => {
    settings[id] = el.checked; saveSettings();
    if (id === 'autoInterp') scheduleInterpret();
    if (id === 'twoReadings' || id === 'pageCheck') applyReadMode();
  });
}

// Fast / Balanced / Careful beside Live: a shortcut for the two settings that decide how many
// readings are paid for. Changing either checkbox by hand shows 'Custom'.
const READ_MODES = {
  fast: { twoReadings: false, pageCheck: false },
  balanced: { twoReadings: true, pageCheck: false },
  careful: { twoReadings: true, pageCheck: true },
};
const READ_TIPS = {
  fast: 'Fast: one reading per region (about 0.2 ¢ each with the default models)',
  balanced: 'Balanced: two readings per region from two different images, a third by the final model when they differ (about 0.7 ¢ per region)',
  careful: 'Careful: as Balanced, and Interpret page also reads the whole page independently and flags every region where the two differ (an interpretation costs about twice as much)',
  custom: 'Custom: set by hand under ⚙ Settings → Reading accuracy',
};
function readModeOf() {
  return Object.keys(READ_MODES).find(m => READ_MODES[m].twoReadings === !!settings.twoReadings
    && READ_MODES[m].pageCheck === !!settings.pageCheck) || 'custom';
}
function applyReadMode() {
  const sel = $('#readMode');
  const m = readModeOf();
  sel.querySelector('[value=custom]').hidden = m !== 'custom';
  sel.value = m;
  sel.title = `How carefully the AI reads. ${READ_TIPS[m]}`;
  $('#twoReadings').checked = !!settings.twoReadings;
  $('#pageCheck').checked = !!settings.pageCheck;
}
$('#readMode').addEventListener('change', e => {
  const m = e.target.value;
  if (!READ_MODES[m]) return;
  Object.assign(settings, READ_MODES[m]);
  saveSettings();
  applyReadMode();
  toast(READ_TIPS[m]);
});
applyReadMode();

// panel filter: all cards / only those that need attention
$('#cardFilter').addEventListener('click', e => {
  const f = e.target.closest('button')?.dataset.f;
  if (!f) return;
  settings.cardFilter = f; saveSettings();
  applyCardFilter(layoutOf());
});

// Preview: held, not toggled. Pointer on the button, or the Space key anywhere outside a text field.
const previewBtn = $('#previewBtn');
previewBtn.addEventListener('pointerdown', e => { e.preventDefault(); previewBtn.setPointerCapture?.(e.pointerId); setPreview(true); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) previewBtn.addEventListener(ev, () => setPreview(false));
window.addEventListener('blur', () => setPreview(false)); // a window that loses focus never sees the key go up
const settingsMenu = $('#settingsMenu');
$('#settingsBtn').addEventListener('click', e => { e.stopPropagation(); settingsMenu.hidden = !settingsMenu.hidden; });

// Drop-down menus open leftwards from their button; when the toolbar wraps and the button sits near
// the left edge, that would put them off screen, so they flip to open rightwards instead.
function keepOnScreen(el) {
  if (el.hidden) return;
  el.style.left = ''; el.style.right = '';
  const r = el.getBoundingClientRect();
  if (r.left < 8) { el.style.right = 'auto'; el.style.left = '0'; }
  else if (r.right > window.innerWidth - 8) { el.style.left = 'auto'; el.style.right = '0'; }
}
for (const id of ['sendMenu', 'settingsMenu']) {
  const el = $('#' + id);
  new ResizeObserver(() => keepOnScreen(el)).observe(el); // shown, or its content changed
}
window.addEventListener('resize', () => ['sendMenu', 'settingsMenu'].forEach(id => keepOnScreen($('#' + id))));
$('#diagBtn').addEventListener('click', () => { settingsMenu.hidden = true; toggleDiag(); });
settingsMenu.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => { settingsMenu.hidden = true; });

const penBtnEl = $('#penButton');
penBtnEl.value = board.penButton = settings.penButton || 'erase';
penBtnEl.addEventListener('change', () => { board.penButton = settings.penButton = penBtnEl.value; saveSettings(); });

// transparency of the students' comment/question markers (Settings → Board)
{
  const el = $('#dotOpacity'), val = $('#dotOpacityVal');
  const apply = v => { document.documentElement.style.setProperty('--dot-opacity', v); val.textContent = Math.round(v * 100) + ' %'; };
  el.value = settings.dotOpacity ?? 1;
  apply(el.value);
  el.addEventListener('input', () => { settings.dotOpacity = +el.value; apply(el.value); saveSettings(); });
}

const orientEl = $('#orientation');
orientEl.value = settings.orientation;
board.setPageSize(settings.orientation);
orientEl.addEventListener('change', () => { settings.orientation = orientEl.value; saveSettings(); board.setPageSize(settings.orientation); renderAll(); saveSoon(); });

for (const id of ['liveModel', 'finalModel']) {
  const sel = $('#' + id);
  const opts = engine => Object.entries(MODELS).filter(([k]) => k !== 'context' && engineOf(k) === engine)
    .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  sel.innerHTML = Object.entries(ENGINES).map(([e, label]) => `<optgroup label="${label}" data-engine="${e}">${opts(e)}</optgroup>`).join('');
  sel.value = settings[id];
  sel.addEventListener('change', () => { settings[id] = sel.value; saveSettings(); renderAll(); });
}
// grey out an engine whose API key is not set on the server
// (in the cloud this waits for the 📡 Send login: checkEngines runs again after signing in)
function checkEngines() { return aiFetch('GET').then(r => r.json()).then(e => {
  if (e.error) throw new Error(e.error);
  coreFeatures = e.features || {}; // an older AI core reports none: no grey context, no page reading
  for (const id of ['liveModel', 'finalModel']) {
    for (const g of $('#' + id).querySelectorAll('optgroup')) {
      const on = !!e[g.dataset.engine];
      g.disabled = !on;
      if (!on) g.label += ' (no API key)';
    }
  }
  const keyName = { claude: 'ANTHROPIC_API_KEY', mistral: 'MISTRAL_API_KEY', openai: 'OPENAI_API_KEY' };
  $('#engineStatus').innerHTML = 'Engines: ' + Object.entries(ENGINES)
    .map(([k, label]) => e[k] ? `${label} ✓` : `${label} <span title="set ${keyName[k]} and restart the server">(no API key)</span>`).join(' · ')
    + (AI_CLOUD ? ' · in the cloud' : ' · local server')
    + (e.student ? '<br>' + studentRulesText(e.student) : '');
  if (e.student) {
    student?.setRules(e.student);
    if (e.student.pay !== 'own' && e.student.models) {
      settings.liveModel = e.student.models.live; settings.finalModel = e.student.models.final;
      for (const [id, v] of [['liveModel', settings.liveModel], ['finalModel', settings.finalModel]]) {
        const sel = $('#' + id); sel.value = v; sel.disabled = true; sel.title = 'Chosen by your lecturer for this course';
      }
      renderAll();
    }
  }
}).catch(err => { if (AI_CLOUD) $('#engineStatus').textContent = 'AI in the cloud: ' + err.message; }); }
checkEngines();
const autoEl = $('#auto');
autoEl.checked = settings.auto;
autoEl.addEventListener('change', () => {
  settings.auto = autoEl.checked; saveSettings();
  if (settings.auto) curPage().blocks.filter(b => b.status === 'stale').forEach(b => transcribe(b, settings.liveModel));
});

$('#finalizeAll').addEventListener('click', () => {
  const todo = curPage().blocks.filter(b => !b.confirmed && b.status !== 'busy' && b.result?.kind !== 'empty');
  if (!todo.length) { toast('Nothing to finalize'); return; }
  todo.forEach(b => transcribe(b, settings.finalModel));
});
$('#interpret').addEventListener('click', () => { settings.panel = true; applyPanel(); interpretPage(); });

// pages
function gotoPage(i) {
  clearErrorMarks(false);
  clearTimeout(regroupTimer);
  regroup(); // settle pending strokes on the page we leave
  state.cur = i;
  for (const el of cardEls.values()) el.remove();
  cardEls.clear();
  board.setPage(curPage());
  $('#boardWrap').scrollTop = 0;
  renderAll();
  send?.changed(); // students following the lecturer switch page too
}
$('#pagePrev').addEventListener('click', () => state.cur > 0 && gotoPage(state.cur - 1));
$('#pageNext').addEventListener('click', () => state.cur < state.pages.length - 1 && gotoPage(state.cur + 1));
$('#pageNew').addEventListener('click', () => { state.pages.splice(state.cur + 1, 0, newPage()); gotoPage(state.cur + 1); });

// panel
function applyPanel() {
  document.body.classList.toggle('no-panel', !settings.panel);
  $('#panelToggle').classList.toggle('on', !!settings.panel);
  $('#panel').style.width = (settings.panelWidth || 400) + 'px';
  const z = settings.panelZoom || 1;
  $('#panelBody').style.setProperty('--panel-zoom', z);
  $('#panelZoomReset').textContent = Math.round(z * 100) + '%';
}
$('#panelToggle').addEventListener('click', () => { settings.panel = !settings.panel; saveSettings(); applyPanel(); });

// text size of the panel on its own: buttons, or Ctrl + wheel over the panel
function setPanelZoom(z) {
  settings.panelZoom = Math.round(Math.max(0.6, Math.min(2.5, z)) * 100) / 100;
  saveSettings();
  applyPanel();
}
$('#panelZoomOut').addEventListener('click', () => setPanelZoom((settings.panelZoom || 1) / 1.1));
$('#panelZoomIn').addEventListener('click', () => setPanelZoom((settings.panelZoom || 1) * 1.1));
$('#panelZoomReset').addEventListener('click', () => setPanelZoom(1));
$('#panel').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault(); // zoom the panel, not the whole browser page
  setPanelZoom((settings.panelZoom || 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });

// drag the border between page and panel
$('#panelResizer').addEventListener('pointerdown', e => {
  const bar = e.currentTarget;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('dragging');
  const move = ev => {
    settings.panelWidth = Math.round(Math.max(240, Math.min(window.innerWidth * 0.75, window.innerWidth - ev.clientX)));
    $('#panel').style.width = settings.panelWidth + 'px';
  };
  const up = () => {
    bar.classList.remove('dragging');
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    saveSettings();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
});
applyPanel();

// photos
$('#photoBtn').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', e => { [...e.target.files].forEach(addPhoto); e.target.value = ''; });
document.addEventListener('paste', e => {
  if (e.target.closest && e.target.closest('textarea, input')) return;
  for (const item of e.clipboardData?.items || []) if (item.type.startsWith('image/')) addPhoto(item.getAsFile());
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  for (const f of e.dataTransfer?.files || []) (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) ? importSlides : addPhoto)(f);
});

// export (section of the settings window); the window closes after an export
const menu = $('#exportMenu');
menu.addEventListener('click', e => {
  const what = e.target.dataset.export;
  if (!what) return;
  if (what !== 'load') settingsMenu.hidden = true;
  if (what === 'copy-latex') copyText(allLatex(), 'All LaTeX copied');
  if (what === 'tex') download(`ink2latex-${stamp()}.tex`,
    `\\documentclass{article}\n\\usepackage{amsmath,amssymb}\n\\usepackage{tikz}\n\\begin{document}\n\n${allLatex()}\n\n\\end{document}\n`, 'application/x-tex');
  if (what === 'md') download(`ink2latex-${stamp()}.md`, allMarkdown(), 'text/markdown');
  if (what === 'print') printNow();
  if (what === 'save') download(`ink2latex-${stamp()}.json`, JSON.stringify(serialize(true)), 'application/json');
  if (what === 'load') $('#loadInput').click();
});
$('#loadInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { restore(JSON.parse(await f.text())); toast('Session loaded'); } catch (err) { toast('Could not load: ' + err.message); }
});

// keyboard
document.addEventListener('keydown', e => {
  if (e.target.isContentEditable || (e.target.closest && e.target.closest('textarea, input, select'))) return;
  if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); setPreview(true); return; } // hold Space = preview
  const k = e.key.toLowerCase();
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    // pen palettes (held keys) and the shortcut list
    if (k === 'c') { e.preventDefault(); penKeyDown('c', 'style'); return; }
    if (k === 'r') { e.preventDefault(); penKeyDown('r', 'recall'); return; }
    if (k === 's') { e.preventDefault(); penKeyDown('s', 'store', 250); return; }
    if (k === 'k') { e.preventDefault(); if (!e.repeat) toggleKeys(); return; }
    if (penPop && penPop.dataset.mode !== 'style' && /^[1-5]$/.test(k)) { e.preventDefault(); chooseSlot(Number(k) - 1); return; }
    if (k === 'escape' && (penPop || $('#keysDlg'))) { closePenPop(); $('#keysDlg')?.remove(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); board.undo(); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); board.redo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'p') { e.preventDefault(); printNow(); }
  else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'd') { e.preventDefault(); toggleDiag(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'g' && board.sel) {
    // Ctrl+G groups the selection, Ctrl+Shift+G ungroups a selected group (as in PowerPoint)
    e.preventDefault();
    const g = selectedGroup();
    const st = board.selStrokes();
    board.clearSelection();
    if (e.shiftKey) { if (g) ungroup(g); else toast('Select a whole group first (click it once in Select mode)'); }
    else if (st.length) groupStrokes(st);
  }
  else if (!e.ctrlKey && !e.metaKey && k === 'p') togglePenLaser();
  else if (!e.ctrlKey && !e.metaKey && k === 'e') setTool(board.tool === 'eraser' ? 'pen' : 'eraser'); // E toggles
  else if (!e.ctrlKey && !e.metaKey && (k === 's' || k === 'g')) setTool('lasso');
  else if (!e.ctrlKey && !e.metaKey && k === 'b') toggleBoxes();
  else if (!e.ctrlKey && !e.metaKey && k === 'i' && curPage().panes?.length) setInteract(!htmlInteract);
  else if (!e.ctrlKey && !e.metaKey && k === 't') setTool('text');
  else if (k === 'escape' && $('#pagesView')) closePages();
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 'arrowright' || k === 'pagedown')) { e.preventDefault(); if (state.cur < state.pages.length - 1) gotoPage(state.cur + 1); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 'arrowleft' || k === 'pageup')) { e.preventDefault(); if (state.cur > 0) gotoPage(state.cur - 1); }
  else if ((k === 'delete' || k === 'backspace') && board.sel) { e.preventDefault(); board.deleteSelection(); }
  else if (k === 'escape') board.clearSelection();
  else if (k === 'enter' && board.hover) {
    // pen (or mouse) hovering over a question + Enter: answer it (map a Wacom ExpressKey to Enter)
    const hit = regionAt(board.hover);
    if (hit) { e.preventDefault(); requestAnswer(hit.b); }
  }
});
// Space up ends the preview (and must not also click whatever button has focus)
document.addEventListener('keyup', e => { if (e.key === ' ' && previewHeld) { e.preventDefault(); setPreview(false); } });

// ----------------------------------------------------------------------------------- start
board.setPage(curPage());
renderAll();
renderCost();
// the saved session: IndexedDB, or (sessions saved before) localStorage. sessionReady: sending may
// only start once this has run (it would otherwise send an empty board)
const sessionReady = (async () => {
  let saved = null;
  try { saved = await idb.get('session'); } catch { /* not available */ }
  if (!saved) saved = store.get('ink2latex.session', null);
  try { if (saved) restore(saved); } catch { /* start fresh */ }
})();

// for automated testing
send = initSend({ state, settings, saveSettings, pagePayload, orientation: () => settings.orientation, toast, board,
  gotoPage: i => { if (i !== state.cur && i < state.pages.length) gotoPage(i); },
  boardData: () => serialize(false), switchBoard, fromSentPages, uploadPending: uploadPendingImages, sessionReady,
  sentIndex, realIndex, onLogin: () => { if (AI_CLOUD) checkEngines(); } });
if (AI_CLOUD) checkEngines(); // now that the login can be read

// ----------------------------------------------------------------------------------- student mode
// Opened with ?join=CODE (the student app's "✍ My board"): the student's own board for that
// lecture (this browser + the cloud, private), the lecturer's tools hidden, AI under the course rules.
student = initStudent({ settings, saveSettings, boardData: () => serialize(false), toast });
assign = initAssign({ settings, saveSettings, state, boardData: () => serialize(false), switchBoard, flattenPage, toast, send, student,
  uploadPending: uploadPendingImages, saveNow });
sessionReady.then(() => { if (!student.active()) assign.sync(); }); // a hand-in under review: its bar
function studentRulesText(r) {
  const names = { ink: 'transcription', calc: '= ?', sym: '= ?S', solve: '= ?AI', latex: '∑ LaTeX', coach: 'coach' };
  const on = Object.entries(r.features || {}).filter(([, v]) => v).map(([k]) => names[k]).filter(Boolean);
  const name = v => [...document.querySelectorAll('#liveModel option')].find(o => o.value === v)?.textContent || v;
  const models = r.pay !== 'own' && r.models ? ` · models: ${name(r.models.live)} (live), ${name(r.models.final)} (final)` : '';
  return `Your lecturer allows: ${on.join(', ') || 'no AI'}${models}${r.pay === 'own' ? ' · with your own key (below)' : ` · up to ${Number(r.daily_limit || 0).toFixed(2)} USD per day`}`;
}
async function enterStudentMode() {
  const lec = student.lecture();
  document.body.classList.add('student-mode');
  const chip = document.createElement('span');
  chip.id = 'studentChip';
  chip.innerHTML = `🎓 ${esc(lec.course_code)} · ${esc(lec.title)} <button title="Leave: back to the lecturer whiteboard on this device">Leave</button>`;
  $('#sendBtn').closest('.menu').before(chip);
  chip.querySelector('button').addEventListener('click', async () => {
    await student.saveNow();
    student.leave();
    await switchBoard(settings.sendLecture?.id || null, {});
    location.href = location.pathname; // without ?join
  });
  try { localStorage.getItem('ink2latex.ownKey') && ($('#ownKey').value = '••••••••'); } catch { /* no storage */ }
  await sessionReady;
  // the student's own board for this lecture ('stu:' keeps it apart from any lecturer board)
  if (assign.isBoard(settings.boardLecture) && assign.ctx()) assign.sync(); // an assignment / feedback board: stay there
  else await switchBoard('stu:' + lec.id, { fetchCloud: () => student.loadBoard() });
  assign.refreshBadge();
  if (new URLSearchParams(location.search).has('asg')) assign.openDialog();
  checkEngines();
  toast(`Your own board for "${lec.title}". It is private and saved automatically.`);
}
$('#ownKey').addEventListener('change', e => {
  const v = e.target.value.trim();
  try { if (v && !/^•+$/.test(v)) localStorage.setItem('ink2latex.ownKey', v); else if (!v) localStorage.removeItem('ink2latex.ownKey'); } catch { /* no storage */ }
  e.target.value = v ? '••••••••' : '';
  toast(v ? 'Key kept in this browser only' : 'Key removed');
});
(async () => {
  const code = new URLSearchParams(location.search).get('join');
  if (code && code.toUpperCase() !== settings.studentLecture?.code) {
    try { await student.join(code); } catch (err) { toast('Could not join: ' + (err.message || err)); return; }
  }
  if (student.active()) enterStudentMode();
})();

// Settings → Students (lecturer): the rules for the course of the chosen lecture
async function loadStudentSettings() {
  if (student?.active()) return;
  const lec = settings.sendLecture, form = $('#stuForm');
  const cs = lec && await send?.courseSettings(lec.course_code).catch(() => null);
  if (!lec || cs === null) { form.hidden = true; $('#stuCourse').textContent = lec ? 'Sign in under 📡 Send to set the rules for students.' : 'Choose a lecture under 📡 Send first: these rules are per course.'; return; }
  const r = { features: { ink: true, calc: true, sym: false, solve: false, latex: true, coach: false }, daily_limit: 0.2, pay: 'course', coaching: '', ...(cs || {}) };
  r.features = { ink: true, calc: true, sym: false, solve: false, latex: true, coach: false, ...(cs?.features || {}) };
  r.models = { live: 'mistral-small', final: 'mistral-medium', ...(cs?.models || {}) };
  // the same model list as the board's own Live / Final menus
  for (const [id, v] of [['#stuLive', r.models.live], ['#stuFinal', r.models.final]]) {
    $(id).innerHTML = $('#liveModel').innerHTML;
    $(id).querySelectorAll('optgroup').forEach(g => { g.disabled = false; g.label = g.label.replace(' (no API key)', ''); });
    $(id).value = v;
  }
  $('#stuCourse').textContent = `Course ${lec.course_code}: what students may use on their own whiteboards ("✍ My board" in the student app).`;
  form.querySelectorAll('[data-sf]').forEach(cb => { cb.checked = !!r.features[cb.dataset.sf]; });
  $('#stuPay').value = r.pay; $('#stuLimit').value = r.daily_limit; $('#stuCoach').value = r.coaching || '';
  form.hidden = false;
}
$('#settingsBtn').addEventListener('click', () => { if (!$('#settingsMenu').hidden) loadStudentSettings(); });
$('#stuSave').addEventListener('click', async () => {
  const lec = settings.sendLecture;
  if (!lec) return;
  const features = {};
  $('#stuForm').querySelectorAll('[data-sf]').forEach(cb => { features[cb.dataset.sf] = cb.checked; });
  const data = { features, models: { live: $('#stuLive').value, final: $('#stuFinal').value }, pay: $('#stuPay').value, daily_limit: Math.max(0, +$('#stuLimit').value || 0), coaching: $('#stuCoach').value.trim() };
  $('#stuState').textContent = 'saving…';
  try { await send.saveCourseSettings(lec.course_code, data); $('#stuState').textContent = 'saved'; }
  catch (err) { $('#stuState').textContent = 'not saved: ' + (err.message || err); }
});

window.ink2latex = { state, board, regroup, settings, interpretPage, evaluateBlock, questionOf, renderAll, send, assign, flattenPage,
  regionAt, bumpLayout: () => { layoutVer++; } };
