// DTUwrite student viewer: join a lecture with its code, follow the lecturer's pages live, read the
// AI transcription. Standalone (libraries from the CDN), so this folder can be hosted anywhere static.
// Students sign in anonymously; row level security only lets them read lectures they joined.

import { SUPABASE_URL, SUPABASE_KEY, SCHEMA, LIBS } from './config.js?v=2026-10-06.1231';
import { TextLayer } from './textboxes.js?v=2026-10-06.1231';
import { drawImages } from './figures.js?v=2026-10-06.1231';
import { initFullscreen } from './fullscreen.js?v=2026-10-06.1231';
import { paneLayer } from './panes.js?v=2026-10-06.1231';

const $ = s => document.querySelector(s);
const PAGE = { portrait: [1200, 1697], landscape: [1697, 1200], wide: [1920, 1080] };
const PALETTE = { auto: '#1b1b1b', blue: '#1f5fd1', red: '#c62828', green: '#2e7d32', orange: '#e65100', purple: '#6a1b9a', teal: '#00838f', yellow: '#f9a825' };
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let sb = null, getStroke = null, channel = null, pollTimer = 0;
let lecture = null;       // {id, title, course_code}
let pages = [];           // [{page_no, version}]
let cur = 0;              // page shown
let lecturerPage = 0;     // page the lecturer is on
let row = null;           // the lecture_pages row shown
const cache = new Map();  // page_no -> row

// ----------------------------------------------------------------------------------- libraries
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l); }

async function loadLibs() {
  loadCss(LIBS.katexCss);
  const [sbmod, pf] = await Promise.all([import(LIBS.supabase), import(LIBS.freehand), loadScript(LIBS.katexJs)]);
  getStroke = pf.getStroke || pf.default?.getStroke || pf.default;
  sb = sbmod.createClient(SUPABASE_URL, SUPABASE_KEY, {
    db: { schema: SCHEMA },
    auth: { storageKey: 'ink2latex-student', persistSession: true, autoRefreshToken: true },
  });
}

async function signedIn() {
  const { data } = await sb.auth.getSession();
  if (data.session) return;
  const { error } = await sb.auth.signInAnonymously();
  if (error) throw error;
}

// ----------------------------------------------------------------------------------- join / leave
function show(id) { for (const s of ['join', 'lecture']) $('#' + s).hidden = s !== id; }
const joinMsg = t => { $('#joinMsg').textContent = t; };

async function join(code) {
  code = String(code || '').trim().toUpperCase();
  joinMsg('');
  if (!/^[A-Z0-9]{6}$/.test(code)) { joinMsg('The code has 6 letters or digits.'); return; }
  try {
    await signedIn();
    const { data, error } = await sb.rpc('join_lecture', { code });
    if (error) throw error;
    if (!data || !data.length) { joinMsg('No lecture with that code.'); LS.del('ink2latex.viewer'); return; }
    lecture = data[0];
    LS.set('ink2latex.viewer', { code, id: lecture.id });
    await openLecture();
  } catch (err) {
    joinMsg('Could not join: ' + (err.message || err));
  }
}

function leave() {
  channel?.unsubscribe();
  clearInterval(pollTimer);
  LS.del('ink2latex.viewer');
  lecture = null; row = null; cache.clear(); notes.clear(); typed.clear(); boxes.clear(); setTextMode(false);
  setNoteMode(false);
  history.replaceState(null, '', location.pathname);
  show('join');
}

// the whiteboard: next to this page on the web site (…/ink2latex/board/), or the local server's root
const BOARD_URL = location.pathname.includes('/viewer/') ? '/' : 'board/';
async function openLecture() {
  show('lecture');
  const code = LS.get('ink2latex.viewer')?.code;
  $('#boardLink').href = `${BOARD_URL}?join=${encodeURIComponent(code || '')}`;
  $('#asgLink').href = `${BOARD_URL}?join=${encodeURIComponent(code || '')}&asg=1`;
  $('#lecTitle').textContent = lecture.title;
  $('#lecCourse').textContent = lecture.course_code;
  document.title = `${lecture.title} · DTUwrite`;
  await refreshList();
  const { data } = await sb.from('lectures').select('current_page').eq('id', lecture.id).maybeSingle();
  lecturerPage = data?.current_page ?? 0;
  await showPage(nearestPage($('#follow').checked ? lecturerPage : 0));
  subscribe();
  // safety net if live updates are blocked by the network: check every 20 s
  clearInterval(pollTimer);
  pollTimer = setInterval(poll, 20000);
}

// ----------------------------------------------------------------------------------- data
async function refreshList() {
  const { data, error } = await sb.from('lecture_pages').select('page_no, version').eq('lecture_id', lecture.id).order('page_no');
  if (!error) pages = data || [];
  updateNav();
}

async function fetchPage(no) {
  const { data, error } = await sb.from('lecture_pages').select('*').eq('lecture_id', lecture.id).eq('page_no', no).maybeSingle();
  if (error) throw error;
  if (data) cache.set(no, data); else cache.delete(no);
  return data;
}

const nearestPage = no => (pages.some(p => p.page_no === no) ? no : pages.length ? pages[pages.length - 1].page_no : 0);

async function showPage(no) {
  if (no !== cur) closePlace();
  cur = no;
  updateNav();
  // a page fetched earlier is used only if it is still the version the lecturer last sent
  const known = cache.get(no), version = pages.find(p => p.page_no === no)?.version;
  row = known && known.version === version ? known : await fetchPage(no).catch(() => known || null);
  await Promise.all([loadNotes(no).catch(() => {}), loadBoxes(no).catch(() => {})]);
  myText.setTexts(boxes.get(no)?.texts || (boxes.set(no, { id: null, texts: [] }), boxes.get(no).texts));
  render();
  loadTyped(no).catch(() => {});
}

function subscribe() {
  channel?.unsubscribe();
  channel = sb.channel('lecture-' + lecture.id)
    .on('postgres_changes', { event: '*', schema: SCHEMA, table: 'lecture_pages', filter: `lecture_id=eq.${lecture.id}` },
      p => pageChanged(p.new?.page_no ?? p.old?.page_no))
    .on('postgres_changes', { event: 'UPDATE', schema: SCHEMA, table: 'lectures', filter: `id=eq.${lecture.id}` },
      p => { lecturerPage = p.new.current_page; if ($('#follow').checked) refreshList().then(() => showPage(nearestPage(lecturerPage))); else updateNav(); })
    .on('postgres_changes', { event: '*', schema: SCHEMA, table: 'questions', filter: `lecture_id=eq.${lecture.id}` }, () => loadTyped(cur).catch(() => {}))
    .subscribe(status => {
      $('#liveDot').className = status === 'SUBSCRIBED' ? 'on' : status === 'CLOSED' || status === 'CHANNEL_ERROR' ? 'off' : '';
      $('#liveDot').title = status === 'SUBSCRIBED' ? 'live' : status.toLowerCase();
    });
}

const pending = new Map();
function pageChanged(no) {
  // the notification only says which page changed; the page itself is fetched (it can be large)
  clearTimeout(pending.get(no));
  pending.set(no, setTimeout(async () => {
    await refreshList();
    if (no === cur) { row = await fetchPage(no).catch(() => row); render(); } else cache.delete(no);
  }, 300));
}

async function poll() {
  if (!lecture) return;
  loadTyped(cur).catch(() => {}); // replies from the lecturer
  const before = pages.find(p => p.page_no === cur)?.version;
  await refreshList();
  const { data } = await sb.from('lectures').select('current_page').eq('id', lecture.id).maybeSingle();
  if (data && data.current_page !== lecturerPage) {
    lecturerPage = data.current_page;
    if ($('#follow').checked) { await showPage(nearestPage(lecturerPage)); return; }
  }
  if (pages.find(p => p.page_no === cur)?.version !== before) { row = await fetchPage(cur).catch(() => row); render(); }
}

// ----------------------------------------------------------------------------------- navigation
function updateNav() {
  const i = pages.findIndex(p => p.page_no === cur);
  $('#pageNo').textContent = pages.length ? `${(i < 0 ? 0 : i) + 1} / ${pages.length}` + (lecturerPage !== cur ? ` (lecturer on ${pages.findIndex(p => p.page_no === lecturerPage) + 1})` : '') : '–';
  $('#prev').disabled = i <= 0;
  $('#next').disabled = i < 0 || i >= pages.length - 1;
}
function step(d) {
  const i = pages.findIndex(p => p.page_no === cur);
  const t = pages[i + d];
  if (!t) return;
  $('#follow').checked = false; // browsing on your own
  showPage(t.page_no);
}

// ----------------------------------------------------------------------------------- rendering
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function tex(src, display) {
  try { return katex.renderToString(String(src), { displayMode: display, throwOnError: false, strict: false }); }
  catch { return `<code>${esc(src)}</code>`; }
}
function renderMixed(text) {
  return String(text ?? '').split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g).map(p => {
    if (p.startsWith('$$') && p.endsWith('$$') && p.length > 4) return tex(p.slice(2, -2), true);
    if (p.startsWith('$') && p.endsWith('$') && p.length > 2) return tex(p.slice(1, -1), false);
    return esc(p).replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');
  }).join('');
}
function renderDoc(md) {
  return String(md || '').split(/\n\s*\n/).map(par => {
    const h = par.match(/^\s*#{1,6}\s+(.*)$/s);
    if (h) return `<h3>${renderMixed(h[1])}</h3>`;
    const t = par.trim();
    const it = t.match(/^\*([^*][\s\S]*[^*])\*$/);
    return it ? `<p><em>${renderMixed(it[1])}</em></p>` : `<p>${renderMixed(t)}</p>`;
  }).join('');
}

const avg = (a, b) => (a + b) / 2;
function svgPath(points) {
  if (points.length < 4) return '';
  let a = points[0], b = points[1];
  const c = points[2];
  let d = `M${a[0]},${a[1]} Q${b[0]},${b[1]} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`;
  for (let i = 2; i < points.length - 1; i++) { a = points[i]; b = points[i + 1]; d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `; }
  return d + 'Z';
}
function strokePath(s) {
  const outline = getStroke(s.pts, {
    size: s.size, thinning: s.shape ? 0 : s.size < 2 ? 0.15 : 0.55, smoothing: 0.5,
    streamline: s.shape ? 0 : s.pen ? 0.15 : 0.4, simulatePressure: !s.pen && !s.shape, last: true,
  });
  if (outline.length < 4) { const p = new Path2D(); p.arc(s.pts[0][0], s.pts[0][1], s.size / 2, 0, Math.PI * 2); return p; }
  return new Path2D(svgPath(outline));
}
function boxOf(strokes) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const s of strokes) for (const [x, y] of s.pts) {
    b.x0 = Math.min(b.x0, x - s.size / 2); b.y0 = Math.min(b.y0, y - s.size / 2);
    b.x1 = Math.max(b.x1, x + s.size / 2); b.y1 = Math.max(b.y1, y + s.size / 2);
  }
  return b;
}

// regions of the page in reading order, with their boxes
function regions() {
  if (!row) return [];
  const byId = new Map(row.strokes.map(s => [s.id, s]));
  const list = (row.blocks || []).map(b => {
    const st = b.strokeIds.map(id => byId.get(id)).filter(Boolean);
    return st.length ? { b, strokes: st, box: boxOf(st) } : null;
  }).filter(Boolean);
  return list.sort((p, q) => {
    const a = p.box, c = q.box, overlap = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
    return overlap > 0.5 * Math.min(a.y1 - a.y0, c.y1 - c.y0) ? a.x0 - c.x0 : a.y0 - c.y0;
  });
}
const sourceOf = b => (b.edit ?? (b.result?.kind === 'math' ? b.result.latex : b.result?.text) ?? '');
const readable = b => b.result && ['math', 'text', 'mixed'].includes(b.result.kind) && b.status !== 'busy';

let view = 'ink'; // ink | both | typeset | doc
function setView(v) {
  view = v;
  for (const r of document.querySelectorAll('#viewMenu [name=view]')) r.checked = r.value === v;
  LS.set('ink2latex.viewer.view', v);
  render();
}

let renderPending = false, imageRender = 0;
// the lecturer's HTML panes that students run themselves: sandboxed (scripts only: no access to this
// app, the login or the notes), placed between the slide and the ink
const studentPanes = paneLayer($('#sheet'), { sandbox: 'allow-scripts', before: $('#ink') });
function render() {
  if (drawing) { renderPending = true; return; } // the pen is down: redraw after the stroke
  $('#doc').hidden = view !== 'doc';
  $('#sheet').hidden = view === 'doc';
  renderItems();
  if (view === 'doc') {
    $('#doc').innerHTML = row?.interp?.document
      ? `<p class="dim">AI transcription: may contain errors</p>${renderDoc(row.interp.document)}`
      : '<p class="empty">No interpreted document for this page yet.</p>';
    return;
  }
  renderPage(view);
}

function renderPage(view) {
  const [W, H] = PAGE[row?.orientation] || PAGE.portrait;
  const wrap = $('#pageWrap');
  const s = Math.max(0.15, (wrap.clientWidth - 24) / W) * zoom; // zoom 1 = the page fits the width
  const dpr = window.devicePixelRatio || 1;
  const sheet = $('#sheet'), c = $('#ink'), layer = $('#layer');
  sheet.style.width = W * s + 'px'; sheet.style.height = H * s + 'px';
  for (const cv of [c, $('#notes'), $('#imgs')]) {
    cv.width = Math.round(W * s * dpr); cv.height = Math.round(H * s * dpr);
    cv.style.width = W * s + 'px'; cv.style.height = H * s + 'px';
  }
  geo = { s, dpr, W, H };
  // typed text: the lecturer's boxes (read only) and your own (private)
  lecturerText.setScale(s, W, H); lecturerText.setTexts(row?.texts || []);
  myText.setScale(s, W, H); myText.setHidden(!$('#showNotes').checked);
  renderNotes();
  renderPins();
  // layers, bottom to top: page + slides/figures (#imgs), the lecturer's HTML (sandboxed), the ink (#ink)
  const gi = $('#imgs').getContext('2d');
  gi.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
  gi.fillStyle = '#fff';
  gi.fillRect(0, 0, W, H);
  const g = c.getContext('2d');
  g.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
  g.clearRect(0, 0, W, H);
  layer.innerHTML = '';
  studentPanes.update(row?.panes || [], s, W, H, { interact: !noteMode && !textMode });
  if (!row) return;
  // the lecturer's slides and figures, under the ink (drawn again when an image has loaded)
  drawImages(gi, row.images, () => { clearTimeout(imageRender); imageRender = setTimeout(render, 60); });
  const regs = regions();
  const hidden = new Set(), dim = new Set();
  if (view !== 'ink') {
    for (const { b, strokes, box } of regs) {
      if (!readable(b)) continue;
      for (const st of strokes) (view === 'typeset' ? hidden : dim).add(st.id);
      const el = document.createElement('div');
      el.className = 'ts';
      el.innerHTML = b.result.kind === 'math' ? tex(sourceOf(b), true) : renderMixed(sourceOf(b));
      layer.appendChild(el);
      const bw = (box.x1 - box.x0) * s, bh = (box.y1 - box.y0) * s;
      const k = Math.max(0.3, Math.min(bw / el.offsetWidth, bh / el.offsetHeight, 3));
      el.style.transform = `scale(${k})`;
      el.style.left = box.x0 * s + 'px';
      el.style.top = (box.y0 * s + (bh - el.offsetHeight * k) / 2) + 'px';
    }
  }
  for (const st of row.strokes) {
    if (hidden.has(st.id)) continue;
    g.globalAlpha = (dim.has(st.id) ? 0.2 : 1) * (st.alpha || 1);
    const col = PALETTE[st.color] || st.color || '#1b1b1b';
    if (st.dash && st.pts.length > 1) { // a dashed pen line (same drawing as the board's paintStroke)
      g.save(); g.strokeStyle = col; g.lineWidth = st.size; g.lineCap = 'round'; g.lineJoin = 'round';
      g.setLineDash([st.size * 2.2 + 2, st.size * 1.8 + 3]); g.beginPath();
      const p = st.pts; g.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) g.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      g.lineTo(p[p.length - 1][0], p[p.length - 1][1]); g.stroke(); g.restore();
    } else { g.fillStyle = col; g.fill(strokePath(st)); }
  }
  g.globalAlpha = 1;
  // answers to "= □" / "= ?", placed as on the lecturer's board: inside the answer box (scaled to
  // fit), or else right after the question. answer.at comes from the board; older pages lack it.
  for (const { b, box } of regs) {
    if (!b.answer?.latex) continue;
    const el = document.createElement('div');
    el.className = 'ans' + (b.answer.cls === 'ai' ? ' ai' : '');
    el.innerHTML = tex(b.answer.latex, false) + (b.answer.cls === 'ai' ? '<sup class="ai-tag">AI</sup>' : '');
    layer.appendChild(el);
    const at = b.answer.at;
    if (at?.box) {
      const a = at.box, bw = (a.x1 - a.x0) * s, bh = (a.y1 - a.y0) * s;
      el.style.fontSize = '40px';
      const k = Math.min(0.88 * bw / el.offsetWidth, 0.75 * bh / el.offsetHeight, 1.5);
      el.style.transform = `scale(${k})`;
      el.style.left = (a.x0 * s + (bw - el.offsetWidth * k) / 2) + 'px';
      el.style.top = (a.y0 * s + (bh - el.offsetHeight * k) / 2) + 'px';
    } else {
      const q = at?.after || box, h = (q.y1 - q.y0) * s;
      el.style.fontSize = Math.max(10, Math.min(40, h * 0.6)) + 'px';
      el.style.left = (q.x1 * s + 10 * s) + 'px';
      el.style.top = (q.y0 * s + (h - el.offsetHeight) / 2) + 'px';
    }
  }
}

function renderItems() {
  const regs = regions().filter(({ b }) => b.result && b.result.kind !== 'empty');
  const waiting = regions().filter(({ b }) => !b.result).length;
  // the lecturer's "Interpret page" write-up, first (also under View → Document)
  const doc = row?.interp?.document
    ? `<details class="interp" open><summary>The page, interpreted (AI)</summary>${renderDoc(row.interp.document)}</details>` : '';
  $('#items').innerHTML = !row ? '<p class="empty">Nothing has been sent for this page yet.</p>'
    : doc + (!regs.length ? `<p class="empty">No transcription yet${waiting ? ` (${waiting} region${waiting > 1 ? 's' : ''} not transcribed by the lecturer's board yet)` : ''}.</p>`
    : (waiting ? `<p class="empty small">${waiting} more region${waiting > 1 ? 's' : ''} not transcribed yet.</p>` : '') + regs.map(({ b }, i) => {
      const r = b.result;
      const body = r.kind === 'math' ? `<div class="math">${tex(sourceOf(b), true)}</div>`
        : r.kind === 'figure' ? `<p class="empty">Figure: ${renderMixed(sourceOf(b))}</p>`
        : `<div>${renderMixed(sourceOf(b))}</div>`;
      const ans = b.answer?.latex ? `<div class="answer ${b.answer.cls === 'ai' ? 'ai' : ''}">= ${tex(b.answer.latex, false)}<span class="tag">${esc(b.answer.label)}</span></div>` : '';
      return `<div class="item"><div class="num">${i + 1}${b.confirmed ? ' · checked by the lecturer' : ''}</div>${body}${ans}</div>`;
    }).join(''));
}

// ----------------------------------------------------------------------------------- my notes (private)
// The student's own ink on a layer over the lecturer's page: stored in ink2latex.student_notes (one
// 'ink' row per page), readable only by this student. Lecturer updates redraw the page underneath.
const NOTE_COLOR = '#1f5fd1';

// "saving…" / "saved" / errors: a small label in the bottom corner, outside the top bar (text
// changing in the bar made it re-wrap on an iPad, so the page jumped under the pen)
let noteStatusTimer = 0;
function setNoteStatus(text) {
  const el = $('#noteState');
  el.textContent = text;
  clearTimeout(noteStatusTimer);
  if (text && !/…$/.test(text)) noteStatusTimer = setTimeout(() => { el.textContent = ''; }, /not /.test(text) ? 8000 : 2000);
}

// ----------------------------------------------------------------------------------- typed text
// The lecturer's text boxes come with the page (row.texts). Your own text boxes are private: one
// student_notes row per page (kind 'box', the boxes in the column box).
const txColors = () => Object.entries(PALETTE);
const lecturerText = new TextLayer($('#sheet'), { editable: false, colors: txColors, autoColor: () => PALETTE.auto });
const myText = new TextLayer($('#sheet'), {
  colors: txColors, autoColor: () => PALETTE.auto, onChange: () => saveBoxesSoon(),
  defaults: () => ({ font: 'sans', size: 28, color: 'blue' }),
});
let textMode = false;
const boxes = new Map(); // page_no -> {id, texts}
async function loadBoxes(no) {
  if (!lecture || boxes.has(no)) return;
  const { data, error } = await sb.from('student_notes').select('id, box')
    .eq('lecture_id', lecture.id).eq('page_no', no).eq('kind', 'box')
    .order('updated_at', { ascending: false }).limit(1);
  if (error) throw error;
  boxes.set(no, { id: data?.[0]?.id || null, texts: Array.isArray(data?.[0]?.box) ? data[0].box : [] });
}
const boxTimers = new Map();
function saveBoxesSoon(no = cur) {
  setNoteStatus('saving…');
  clearTimeout(boxTimers.get(no));
  boxTimers.set(no, setTimeout(() => saveBoxes(no), 1200));
}
async function saveBoxes(no) {
  const n = boxes.get(no);
  if (!n || !lecture) return;
  try {
    if (n.id) {
      const { error } = await sb.from('student_notes').update({ box: n.texts, updated_at: new Date().toISOString() }).eq('id', n.id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('student_notes').insert({ lecture_id: lecture.id, page_no: no, kind: 'box', box: n.texts }).select('id').single();
      if (error) throw error;
      n.id = data.id;
    }
    setNoteStatus('saved');
  } catch (err) {
    setNoteStatus('text not saved: ' + (err.message || err));
  }
}
function setTextMode(on) {
  textMode = !!on;
  studentPanes?.layer.classList.toggle('interact', !textMode && !noteMode);
  if (textMode) { setNoteMode(false); closePlace(); if (view === 'doc') setView('ink'); if (!$('#showNotes').checked) { $('#showNotes').checked = true; renderNotes(); renderPins(); myText.setHidden(false); } }
  myText.setActive(textMode);
  $('#textMode').classList.toggle('on', textMode);
}
$('#textMode').addEventListener('click', () => setTextMode(!textMode));
let geo = { s: 1, dpr: 1, W: 1200, H: 1697 };
let noteMode = false, noteErase = false, drawing = null, noteRaf = 0;
const notes = new Map(); // page_no -> {id, strokes}
const saveTimers = new Map();

async function loadNotes(no) {
  if (!lecture || notes.has(no)) return;
  const { data, error } = await sb.from('student_notes').select('id, strokes')
    .eq('lecture_id', lecture.id).eq('page_no', no).eq('kind', 'ink')
    .order('updated_at', { ascending: false }).limit(1);
  if (error) throw error;
  notes.set(no, { id: data?.[0]?.id || null, strokes: data?.[0]?.strokes || [] });
}

function renderNotes() {
  const c = $('#notes'), g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  g.setTransform(geo.dpr * geo.s, 0, 0, geo.dpr * geo.s, 0, 0);
  g.fillStyle = NOTE_COLOR;
  if ($('#showNotes').checked) for (const st of notes.get(cur)?.strokes || []) g.fill(notePath(st));
  if (drawing?.stroke) g.fill(strokePath(drawing.stroke)); // only the stroke being written is recomputed
}
// a finished note stroke's outline, computed once (erasing removes strokes, it never changes one)
const notePaths = new WeakMap();
function notePath(st) {
  let p = notePaths.get(st);
  if (!p) { p = strokePath(st); notePaths.set(st, p); }
  return p;
}
const requestNotes = () => { if (!noteRaf) noteRaf = requestAnimationFrame(() => { noteRaf = 0; renderNotes(); }); };

function setNoteMode(on) {
  noteMode = on;
  studentPanes?.layer.classList.toggle('interact', !on && !textMode);
  if (on) setTextMode(false);
  if (!on) noteErase = false;
  document.body.classList.toggle('note-mode', on);
  $('#noteMode').classList.toggle('on', on);
  $('#noteErase').hidden = $('#noteUndo').hidden = !on;
  $('#noteErase').classList.toggle('on', noteErase);
  if (on && view === 'doc') setView('ink');
  if (on && !$('#showNotes').checked) { $('#showNotes').checked = true; renderNotes(); renderPins(); myText.setHidden(!$('#showNotes').checked); }
}

function notePoint(e) {
  const r = $('#notes').getBoundingClientRect();
  return [(e.clientX - r.left) / geo.s, (e.clientY - r.top) / geo.s, e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5];
}
function eraseNotesAt(p) {
  const n = notes.get(cur);
  if (!n) return false;
  const before = n.strokes.length;
  n.strokes = n.strokes.filter(st => !st.pts.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 12 + st.size));
  return n.strokes.length !== before;
}

// saved once the pen has rested for SAVE_IDLE ms; nothing is saved (or shown) while writing
const SAVE_IDLE = 2500;
let lastPenUp = 0;
function saveNotesSoon(no = cur) {
  clearTimeout(saveTimers.get(no));
  saveTimers.set(no, setTimeout(() => saveNotes(no), SAVE_IDLE));
}
async function saveNotes(no) {
  const n = notes.get(no);
  if (!n || !lecture) return;
  if (drawing || performance.now() - lastPenUp < SAVE_IDLE - 100) { saveNotesSoon(no); return; } // still writing
  setNoteStatus('saving…');
  const r1 = v => Math.round(v * 10) / 10;
  const strokes = n.strokes.map(st => ({ size: st.size, pen: st.pen, pts: st.pts.map(([x, y, p]) => [r1(x), r1(y), Math.round(p * 100) / 100]) }));
  try {
    if (n.id) {
      const { error } = await sb.from('student_notes').update({ strokes, updated_at: new Date().toISOString() }).eq('id', n.id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from('student_notes').insert({ lecture_id: lecture.id, page_no: no, kind: 'ink', strokes }).select('id').single();
      if (error) throw error;
      n.id = data.id;
    }
    setNoteStatus('saved');
  } catch (err) {
    setNoteStatus('not saved: ' + (err.message || err));
  }
}

const nc = $('#notes');
$('#pageWrap').addEventListener('contextmenu', e => { if (!e.target.closest('.tx-box.editing')) e.preventDefault(); });
nc.addEventListener('pointerdown', e => {
  dbg('down', e);
  if (e.pointerType === 'pen') penSeen = true;
  if (!noteMode || !notes.has(cur)) return;
  if (e.pointerType === 'touch' && (penSeen || pinch)) return; // fingers scroll and zoom; the pen writes
  e.preventDefault();
  // a second finger while a finger is writing: that is a pinch, not writing (drop the finger's stroke)
  if (e.pointerType === 'touch' && drawing?.touch) { drawing = null; requestNotes(); return; }
  if (drawing) endNote({ pointerId: drawing.id }); // the previous stroke's pen-up never arrived: keep it
  try { nc.setPointerCapture(e.pointerId); } catch { /* not capturable (rare on iOS): draw anyway */ }
  const p = notePoint(e);
  if (noteErase || (e.buttons & 32)) { drawing = { id: e.pointerId, erase: true }; if (eraseNotesAt(p)) requestNotes(); }
  else drawing = { id: e.pointerId, touch: e.pointerType === 'touch', stroke: { size: 3, pen: e.pointerType === 'pen', pts: [p] } };
  requestNotes();
});
nc.addEventListener('pointermove', e => {
  if (!drawing || e.pointerId !== drawing.id) return;
  for (const ev of (e.getCoalescedEvents?.() || [e])) {
    const p = notePoint(ev);
    if (drawing.erase) eraseNotesAt(p); else drawing.stroke.pts.push(p);
  }
  requestNotes();
});
const endNote = e => {
  if (e.type) dbg(e.type === 'pointercancel' ? 'cancel' : 'up', e);
  if (!drawing || e.pointerId !== drawing.id) return;
  if (drawing.stroke) notes.get(cur).strokes.push(drawing.stroke);
  drawing = null;
  lastPenUp = performance.now();
  saveNotesSoon();
  requestNotes();
  if (renderPending) { renderPending = false; render(); } // a lecturer update that came in while writing
};
nc.addEventListener('pointerup', endNote);
nc.addEventListener('pointercancel', endNote);
// iPad Safari: without this, a quick second pen touch can be taken for part of a double-tap gesture
// and its pointer events are swallowed (every other stroke missing). Only while writing notes.
for (const type of ['touchstart', 'touchmove', 'touchend']) {
  nc.addEventListener(type, e => {
    if (type === 'touchstart') dbg('touch', e);
    if (!noteMode) return;
    const stylus = [...e.changedTouches].some(t => t.touchType === 'stylus');
    if (stylus || (fingers(e).length === 1 && !penSeen && !pinch)) e.preventDefault();
  }, { passive: false });
}

// ----------------------------------------------------------------------------------- zoom
// Two fingers: pinch to zoom (0.5x to 5x) and drag to move the page; shown live with a CSS transform,
// drawn sharp at the new size when the fingers lift. Laptops: Ctrl + wheel, or a trackpad pinch.
let zoom = 1, pinch = null, penSeen = false;
const wrapEl = $('#pageWrap');
const fingers = e => [...e.touches].filter(t => t.touchType !== 'stylus');
const clampZoom = z => Math.max(0.5, Math.min(5, z));
// keep the page point that was under (x0, y0) on screen under (x1, y1) after re-drawing at zoom z
function zoomTo(z, x0, y0, x1 = x0, y1 = y0) {
  const r0 = $('#sheet').getBoundingClientRect();
  const px = (x0 - r0.left) / geo.s, py = (y0 - r0.top) / geo.s;
  zoom = clampZoom(z);
  render();
  const r1 = $('#sheet').getBoundingClientRect();
  wrapEl.scrollLeft += r1.left + px * geo.s - x1;
  wrapEl.scrollTop += r1.top + py * geo.s - y1;
}
wrapEl.addEventListener('touchstart', e => {
  const f = fingers(e);
  if (f.length !== 2 || view === 'doc') return;
  e.preventDefault();
  if (drawing?.touch) { drawing = null; requestNotes(); } // the first finger had started a stroke: drop it
  const [a, b] = f, r = $('#sheet').getBoundingClientRect();
  const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, mid0: mid, mid, k: 1 };
  $('#sheet').style.transformOrigin = `${mid.x - r.left}px ${mid.y - r.top}px`;
}, { passive: false });
wrapEl.addEventListener('touchmove', e => {
  if (!pinch) return;
  const f = fingers(e);
  if (f.length < 2) return;
  e.preventDefault();
  const [a, b] = f;
  pinch.k = clampZoom(zoom * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0) / zoom;
  pinch.mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  $('#sheet').style.transform = `translate(${pinch.mid.x - pinch.mid0.x}px, ${pinch.mid.y - pinch.mid0.y}px) scale(${pinch.k})`;
}, { passive: false });
const endPinch = e => {
  if (!pinch || fingers(e).length >= 2) return;
  const p = pinch;
  pinch = null;
  $('#sheet').style.transform = '';
  zoomTo(zoom * p.k, p.mid0.x, p.mid0.y, p.mid.x, p.mid.y);
};
wrapEl.addEventListener('touchend', endPinch);
wrapEl.addEventListener('touchcancel', endPinch);
// Ctrl + wheel (a trackpad pinch arrives as this too)
let wheelTimer = 0, wheelZoom = 0;
wrapEl.addEventListener('wheel', e => {
  if (!e.ctrlKey || view === 'doc') return;
  e.preventDefault();
  wheelZoom = (wheelZoom || zoom) * Math.exp(-e.deltaY * 0.01);
  const x = e.clientX, y = e.clientY;
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => { const z = wheelZoom; wheelZoom = 0; zoomTo(z, x, y); }, 60);
}, { passive: false });

// diagnostics (?debug=1 or &debug=1): what the device reports for each touch, in a corner box
const DEBUG = new URLSearchParams(location.search).has('debug');
const dbgCount = { down: 0, up: 0, cancel: 0, touch: 0 };
let dbgLast = '';
function dbg(kind, e) {
  if (!DEBUG) return;
  dbgCount[kind]++;
  if (kind !== 'touch') dbgLast = `${kind} ${e.pointerType || ''} id ${e.pointerId}${drawing ? ' (stroke open)' : ''}`;
  let box = $('#dbgBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'dbgBox';
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;background:#000c;color:#fff;font:12px ui-monospace,monospace;padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
    document.body.appendChild(box);
  }
  box.textContent = `down ${dbgCount.down}  up ${dbgCount.up}  cancel ${dbgCount.cancel}  touch ${dbgCount.touch}\nlast: ${dbgLast}\nstrokes on page: ${notes.get(cur)?.strokes.length ?? '-'}`;
}
// Typed notes (private), comments and questions (both sent anonymously to the lecturer), per page.
// Double-click on the page writes one right there: it then has x, y in page units and shows as a pin
// (the lecturer sees comments as green and questions as red circles at the same place).
const typed = new Map(); // page_no -> {notes:[{text, x, y}], questions:[{text, kind, status, x, y}]}
async function loadTyped(no) {
  if (!lecture) return;
  const qsel = cols => sb.from('questions').select(cols).eq('lecture_id', lecture.id).eq('page_no', no).order('created_at');
  const [n, q0] = await Promise.all([
    sb.from('student_notes').select('text, x, y, updated_at').eq('lecture_id', lecture.id).eq('page_no', no).eq('kind', 'text').order('updated_at'),
    qsel('text, kind, status, x, y, answer, created_at'),
  ]);
  // before the setup is re-run, questions have no kind, x, y, answer columns yet
  const q = q0.error ? await qsel('text, status, created_at') : q0;
  typed.set(no, { notes: n.data || [], questions: q.error ? [] : q.data || [] });
  renderMine();
  renderPins();
}

const KIND = {
  note: { icon: '📝', done: 'note saved', fail: 'note not saved: ' },
  comment: { icon: '💬', done: 'comment sent (anonymous)', fail: 'comment not sent: ' },
  question: { icon: '?', done: 'question sent (anonymous)', fail: 'question not sent: ' },
};
const kindOf = q => (q.kind === 'comment' ? 'comment' : 'question');

// pins on the page for placed notes, comments and questions; tap one to read it
function renderPins() {
  const box = $('#pins');
  if (!box) return;
  const t = typed.get(cur) || { notes: [], questions: [] };
  const placed = x => x.x != null && x.y != null;
  const status = { open: 'sent to the lecturer', answered: 'answered', hidden: 'seen by the lecturer' };
  const list = [
    ...($('#showNotes').checked ? t.notes.filter(placed).map(n => ({ ...n, k: 'note', tag: 'private note' })) : []),
    ...($('#showQuestions').checked ? t.questions.filter(placed).map(q => ({ ...q, k: kindOf(q), tag: status[q.status] || q.status })) : []),
  ];
  box.hidden = view === 'doc';
  box.innerHTML = list.map(p => `<div class="pin ${p.k}${p.status === 'answered' ? ' answered' : ''}" style="left:${p.x * geo.s}px;top:${p.y * geo.s}px">
      <button class="pin-dot" title="${esc(p.text)}">${KIND[p.k].icon}</button>
      <div class="pin-text">${renderMixed(p.text)}<span class="st">${esc(p.tag)}</span>${p.answer ? `<div class="reply"><b>Lecturer:</b> ${renderMixed(p.answer)}</div>` : ''}</div></div>`).join('');
}
$('#pins').addEventListener('click', e => {
  const pin = e.target.closest('.pin');
  if (!pin) return;
  e.stopPropagation();
  const was = pin.classList.contains('expanded');
  for (const p of $('#pins').querySelectorAll('.pin.expanded')) p.classList.remove('expanded');
  pin.classList.toggle('expanded', !was);
});

// save a note (private), comment or question (to the lecturer, anonymous); x, y = where on the page, or null
async function addMine(text, kind, x = null, y = null) {
  const at = x == null ? {} : { x: Math.round(x), y: Math.round(y) };
  if (kind === 'note') {
    const { error } = await sb.from('student_notes').insert({ lecture_id: lecture.id, page_no: cur, kind: 'text', text, ...at });
    if (error) throw error;
  } else {
    let { error } = await sb.from('questions').insert({ lecture_id: lecture.id, page_no: cur, text, kind, ...at });
    if (error && /column|schema cache/i.test(error.message)) { // setup not re-run yet: send the text only
      ({ error } = await sb.from('questions').insert({ lecture_id: lecture.id, page_no: cur, text: kind === 'comment' ? 'Comment: ' + text : text }));
    }
    if (error) throw error;
  }
  setNoteStatus(KIND[kind].done);
  await loadTyped(cur);
}
// in the side field: "Q: ..." = question, "C: ..." = comment, anything else = private note
function parseTyped(raw) {
  const m = raw.match(/^([qc])\s*[:;]\s*([\s\S]+)/i);
  return m ? { kind: m[1].toLowerCase() === 'q' ? 'question' : 'comment', text: m[2].trim() } : { kind: 'note', text: raw };
}

// double-click (double-tap) on the page: a text field opens right where you clicked
let placeAt = null;
function openPlace(clientX, clientY) {
  if (!lecture || noteMode || textMode || view === 'doc') return;
  const r = $('#sheet').getBoundingClientRect();
  placeAt = { page: cur, x: (clientX - r.left) / geo.s, y: (clientY - r.top) / geo.s };
  const f = $('#placeForm');
  f.hidden = false;
  $('#placeText').value = '';
  // the field's top left corner at the click; moved only as far as needed to stay on screen
  const w = f.offsetWidth, h = f.offsetHeight;
  f.style.left = Math.max(4, Math.min(clientX - 10, innerWidth - w - 4)) + 'px';
  f.style.top = Math.max(4, Math.min(clientY - 10, innerHeight - h - 4)) + 'px';
  $('#placeText').focus();
}
function closePlace() { placeAt = null; const f = $('#placeForm'); if (f) f.hidden = true; }
$('#placeCancel').addEventListener('click', closePlace);
$('#placeText').addEventListener('keydown', e => {
  if (e.key === 'Escape') closePlace();
  // Enter = note (private); Shift+Enter = new line
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#placeForm').requestSubmit($('#placeForm [data-kind=note]')); }
});
$('#placeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const raw = $('#placeText').value.trim();
  if (!raw || !placeAt || placeAt.page !== cur) { closePlace(); return; }
  const kind = e.submitter?.dataset.kind || 'note';
  const { x, y } = placeAt;
  closePlace();
  try { await addMine(raw, kind, x, y); }
  catch (err) { setNoteStatus(KIND[kind].fail + (err.message || err)); }
});
// the pen dragged over the page while My notes is off: say how to write (once the stroke is clearly
// a stroke, not a tap or a double-tap)
// (letters are short strokes: the distance adds up over strokes that follow each other quickly)
let penTry = null, press = null;
$('#sheet').addEventListener('pointerdown', e => {
  press = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
  if (noteMode || textMode || e.pointerType !== 'pen') { penTry = null; return; }
  if (!penTry || performance.now() - penTry.t > 1500) penTry = { d: 0 };
  Object.assign(penTry, { x: e.clientX, y: e.clientY, t: performance.now() });
});
$('#sheet').addEventListener('pointermove', e => {
  if (!(e.buttons & 1)) return;
  if (press) press.moved = Math.max(press.moved, Math.hypot(e.clientX - press.x, e.clientY - press.y));
  if (!penTry) return;
  penTry.d += Math.hypot(e.clientX - penTry.x, e.clientY - penTry.y);
  Object.assign(penTry, { x: e.clientX, y: e.clientY, t: performance.now() });
  if (penTry.d > 80) {
    penTry = null;
    lastTap = null;
    setNoteStatus('To write on the page, switch on ✎ My notes');
    const b = $('#noteMode');
    b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
  }
});
// own double-tap detection: works the same for mouse, pen and finger (phones do not all send dblclick).
// A tap is a short press that hardly moves: the end of a pen stroke is not a tap.
let lastTap = null;
$('#sheet').addEventListener('pointerup', e => {
  if (noteMode || textMode || e.target.closest('.pin')) return;
  const now = performance.now();
  if (!press || press.moved > 12 || now - press.t > 350) { lastTap = null; return; }
  if (lastTap && now - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    openPlace(e.clientX, e.clientY);
  } else lastTap = { t: now, x: e.clientX, y: e.clientY };
});
document.addEventListener('pointerdown', e => {
  if (!$('#placeForm').hidden && !e.target.closest('#placeForm') && !e.target.closest('#sheet')) closePlace();
});
function renderMine() {
  const t = typed.get(cur) || { notes: [], questions: [] };
  const status = { open: 'sent', answered: 'answered', hidden: 'seen' };
  const where = x => (x.x != null ? ' · 📍 on the page' : '');
  $('#myList').innerHTML = [
    ...t.questions.map(q => `<div class="my ${kindOf(q)}">${kindOf(q) === 'comment' ? '💬' : '❓'} ${renderMixed(q.text)}<span class="st">${status[q.status] || q.status}${where(q)}</span>${q.answer ? `<div class="reply"><b>Lecturer:</b> ${renderMixed(q.answer)}</div>` : ''}</div>`),
    ...t.notes.map(x => `<div class="my">📝 ${renderMixed(x.text)}${x.x != null ? '<span class="st">📍 on the page</span>' : ''}</div>`),
  ].join('');
}
$('#noteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const raw = $('#noteText').value.trim();
  if (!lecture) return;
  if (!raw) { $('#noteText').focus(); setNoteStatus('Type a note first (start with C: for a comment or Q: for a question to the lecturer)'); return; }
  const { kind, text } = parseTyped(raw);
  try {
    await addMine(text, kind);
    $('#noteText').value = '';
  } catch (err) {
    setNoteStatus(KIND[kind].fail + (err.message || err));
  }
});

$('#noteMode').addEventListener('click', () => setNoteMode(!noteMode));
$('#noteErase').addEventListener('click', () => { noteErase = !noteErase; $('#noteErase').classList.toggle('on', noteErase); });
$('#noteUndo').addEventListener('click', () => { const n = notes.get(cur); if (n?.strokes.length) { n.strokes.pop(); saveNotesSoon(); requestNotes(); } });

// ----------------------------------------------------------------------------------- start
$('#joinForm').addEventListener('submit', e => { e.preventDefault(); join($('#code').value); });
$('#prev').addEventListener('click', () => step(-1));
$('#next').addEventListener('click', () => step(1));
$('#follow').addEventListener('change', () => { if ($('#follow').checked) showPage(nearestPage(lecturerPage)); });
// the View menu: one of ink / ink + typeset / typeset / document, plus what of your own to show
$('#viewBtn').addEventListener('click', e => { e.stopPropagation(); $('#viewMenu').hidden = !$('#viewMenu').hidden; });
document.addEventListener('click', e => { if (!e.target.closest('#viewWrap')) $('#viewMenu').hidden = true; });
$('#viewMenu').addEventListener('change', e => {
  if (e.target.name === 'view') setView(e.target.value);
  else { LS.set('ink2latex.viewer.show', { notes: $('#showNotes').checked, questions: $('#showQuestions').checked }); renderNotes(); renderPins(); myText.setHidden(!$('#showNotes').checked); }
});
$('#leave').addEventListener('click', leave);
// full screen: the page alone, a small floating bar at the left (fullscreen.js)
const fullscreen = initFullscreen({
  toolbar: $('#bar'),
  hide: [$('#side')],
  menuOpen: () => !$('#viewMenu').hidden,
  tools: [
    { icon: '＋', tip: 'Zoom in (or pinch with two fingers)', run: () => { const r = wrapEl.getBoundingClientRect(); zoomTo(zoom * 1.25, r.left + r.width / 2, r.top + r.height / 2); } },
    { icon: '−', tip: 'Zoom out', run: () => { const r = wrapEl.getBoundingClientRect(); zoomTo(zoom / 1.25, r.left + r.width / 2, r.top + r.height / 2); } },
    { icon: '⤢', tip: 'Fit the page to the width', run: () => { const r = wrapEl.getBoundingClientRect(); zoomTo(1, r.left + r.width / 2, r.top); } },
    null,
    { icon: '◀', tip: 'Previous page', run: () => step(-1) },
    { icon: '▶', tip: 'Next page', run: () => step(1) },
    null,
    { icon: '✎', tip: 'My notes: write on the page (only you see them)', run: () => setNoteMode(!noteMode), on: () => noteMode },
    { icon: 'T', tip: 'Type on the page (only you see it)', run: () => setTextMode(!textMode), on: () => textMode },
  ],
  onChange: () => { if (lecture) setTimeout(render, 250); },
});
$('#fsBtn').addEventListener('click', () => fullscreen.toggle());
// the side panel (notes, transcription): hidden or shown by the student; on narrow screens (phone,
// iPad upright) it starts hidden so the page gets the room
function setSide(on, remember) {
  document.body.classList.toggle('side-off', !on);
  $('#sideBtn').classList.toggle('on', on);
  if (remember) LS.set('ink2latex.viewer.side', on);
  if (lecture) render();
}
$('#sideBtn').addEventListener('click', () => setSide(document.body.classList.contains('side-off'), true));
setSide(LS.get('ink2latex.viewer.side') ?? window.innerWidth >= 1100, false);
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => lecture && render(), 150); });
view = LS.get('ink2latex.viewer.view') || 'ink';
for (const r of document.querySelectorAll('#viewMenu [name=view]')) r.checked = r.value === view;
{ const sh = LS.get('ink2latex.viewer.show'); if (sh) { $('#showNotes').checked = sh.notes !== false; $('#showQuestions').checked = sh.questions !== false; } }

(async () => {
  try { await loadLibs(); } catch {
    $('#boot').textContent = 'Could not load the page (no internet connection?).';
    return;
  }
  $('#boot').hidden = true;
  const code = new URLSearchParams(location.search).get('c') || LS.get('ink2latex.viewer')?.code;
  show('join');
  if (code) { $('#code').value = code; join(code); }
})();

window.ink2latexViewer = { get state() { return { lecture, pages, cur, lecturerPage, row }; } };
