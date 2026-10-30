// DTUwrite student viewer: join a lecture with its code, follow the lecturer's pages live, read the
// AI transcription. Standalone (libraries from the CDN), so this folder can be hosted anywhere static.
// Students sign in anonymously; row level security only lets them read lectures they joined.

import { SUPABASE_URL, SUPABASE_KEY, SCHEMA, LIBS } from './config.js?v=2026-10-30.1151';
import { TextLayer } from './textboxes.js?v=2026-10-30.1151';
import { drawImages } from './figures.js?v=2026-10-30.1151';
import { initFullscreen } from './fullscreen.js?v=2026-10-30.1151';
import { paneLayer } from './panes.js?v=2026-10-30.1151';

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

let me = null; // this student's (anonymous) user id: tells own comments from the others' on a message board page
async function signedIn() {
  const { data } = await sb.auth.getSession();
  if (data.session) { me = data.session.user.id; return; }
  const { data: d, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  me = d.user?.id || null;
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
  setNoteMode(false); closePostForm(); hideCtx(); stopPlacing();
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
  const data = await lectureRow();
  lecturerPage = data?.current_page ?? 0;
  setNoteScale(data?.note_scale);
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
  if (no !== cur) { closePlace(); closePostForm(); hideCtx(); stopPlacing(); }
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
      p => { setNoteScale(p.new.note_scale); if (p.new.current_page === lecturerPage) return; lecturerPage = p.new.current_page; if ($('#follow').checked) refreshList().then(() => showPage(nearestPage(lecturerPage))); else updateNav(); })
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
    if (no === cur) {
      const was = !!row?.board;
      row = await fetchPage(no).catch(() => row);
      render();
      if (!!row?.board !== was) loadTyped(cur).catch(() => {}); // message board on / off: the others' comments come / go
    } else cache.delete(no);
  }, 300));
}

async function poll() {
  if (!lecture) return;
  loadTyped(cur).catch(() => {}); // replies from the lecturer
  const before = pages.find(p => p.page_no === cur)?.version;
  await refreshList();
  const data = await lectureRow();
  setNoteScale(data?.note_scale);
  if (data && data.current_page !== lecturerPage) {
    lecturerPage = data.current_page;
    if ($('#follow').checked) { await showPage(nearestPage(lecturerPage)); return; }
  }
  if (pages.find(p => p.page_no === cur)?.version !== before) { row = await fetchPage(cur).catch(() => row); render(); loadTyped(cur).catch(() => {}); }
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
  if (s.fill) { // a paint-bucket fill: its points are the outline of the area
    const p = new Path2D();
    s.pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
    p.closePath();
    return p;
  }
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
// right-click (or the pen's side button): the menu (edit, move, reply, show all). A long press of a finger
// or the pen also sends contextmenu on some devices: the hold (below) handles those.
$('#pageWrap').addEventListener('contextmenu', e => {
  if (e.target.closest('.tx-box.editing')) return;
  e.preventDefault();
  if (noteMode || textMode || view === 'doc' || (lastDown.type !== 'mouse' && lastDown.button !== 2)) return;
  const el = e.target.closest('#pins .b-reply, #pins .b-note, #pins .pin');
  openCtx(e.clientX, e.clientY, itemOf(el));
});
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
// Typed notes (private), comments and questions (both sent anonymously to the lecturer), and posts
// (anonymous, for everyone: the lecturer's board and every student), per page.
// Double-click on the page writes one right there: it then has x, y in page units and shows as a pin
// (the lecturer sees comments as green and questions as red circles at the same place).
// Posts of everyone show as open notes, live; one the lecturer closed (shown = false) is a pin.
// A message board page (the lecturer's choice, row.board) asks the students to post there.
const typed = new Map(); // page_no -> {notes:[{text, x, y}], questions:[{text, kind, status, x, y}] (own), posts:[of everyone]}
async function loadTyped(no) {
  if (!lecture) return;
  const qsel = cols => sb.from('questions').select(cols).eq('lecture_id', lecture.id).eq('page_no', no).order('created_at');
  const [n, q0] = await Promise.all([
    sb.from('student_notes').select('id, text, x, y, updated_at').eq('lecture_id', lecture.id).eq('page_no', no).eq('kind', 'text').order('updated_at'),
    qsel('id, text, kind, status, x, y, answer, shown, parent, scale, edited_at, created_at, student'),
  ]);
  // before the setup is re-run, questions have no kind, x, y, answer (shown: supabase-board.sql; parent,
  // scale, edited_at: supabase-replies.sql) columns yet
  let q = q0;
  if (q.error) q = await qsel('id, text, kind, status, x, y, answer, shown, created_at, student');
  if (q.error) q = await qsel('id, text, kind, status, x, y, answer, created_at, student');
  if (q.error) q = await qsel('text, status, created_at');
  const all = q.error ? [] : q.data || [];
  const mine = x => !x.student || x.student === me;
  const live = x => x.status !== 'hidden';
  typed.set(no, { notes: n.data || [], questions: all.filter(mine), posts: all.filter(x => kindOf(x) === 'post' && live(x)),
    replies: all.filter(x => kindOf(x) === 'reply' && live(x)) });
  renderMine();
  renderPins();
}

const KIND = {
  note: { icon: '📝', done: 'note saved', fail: 'note not saved: ' },
  post: { icon: '📌', done: 'posted for everyone (anonymous)', fail: 'not posted: ' },
  reply: { icon: '↩', done: 'reply posted (anonymous)', fail: 'reply not posted: ' },
  comment: { icon: '💬', done: 'comment sent (anonymous)', fail: 'comment not sent: ' },
  question: { icon: '?', done: 'question sent (anonymous)', fail: 'question not sent: ' },
};
const kindOf = q => (['comment', 'post', 'reply'].includes(q.kind) ? q.kind : 'question');
const PHONE = Math.min(screen.width, screen.height) < 600;
document.body.classList.toggle('phone', PHONE);
// one size for all of them, chosen by the lecturer (lectures.note_scale). Phones do not use it: there the
// notes shrink with the small page (0.7 at the page's normal fit, the normal size once zoomed in), are
// at most about half the page wide and show three lines until tapped open (viewer.css body.phone)
let noteScale = 1;
const scOf = () => (PHONE ? Math.max(0.7, Math.min(1, 2 * geo.s)) : noteScale > 0 ? noteScale : 1);
function setNoteScale(v) {
  v = v > 0 ? v : 1;
  if (v === noteScale) return;
  noteScale = v;
  renderPins();
}
// the lecture's page and size for the students' notes (no note_scale before supabase-size.sql)
async function lectureRow() {
  let { data, error } = await sb.from('lectures').select('current_page, note_scale').eq('id', lecture.id).maybeSingle();
  if (error) ({ data } = await sb.from('lectures').select('current_page').eq('id', lecture.id).maybeSingle());
  return data;
}

// pins on the page for placed notes, comments and questions; tap one to read it
function renderPins() {
  const box = $('#pins');
  if (!box) return;
  if (hold?.dragging) { pinsPending = true; return; } // one is being dragged: drawn again when it is dropped
  const t = typed.get(cur) || { notes: [], questions: [], posts: [] };
  const placed = x => x.x != null && x.y != null;
  const status = { open: 'sent to the lecturer', answered: 'answered', hidden: 'seen by the lecturer' };
  const yours = q => q.student === me;
  const all = $('#openAll').checked;
  // everyone's posts: open notes (the ones typed in the side panel in a column at the left), or a pin
  // when the lecturer closed it
  const posts = $('#showPosts').checked ? t.posts || [] : [];
  const open = posts.filter(q => q.shown !== false);
  const closed = posts.filter(q => q.shown === false && placed(q)).map(q => ({ ...q, k: 'post', own: yours(q), tag: (yours(q) ? 'your post' : 'post') + ' · closed by the lecturer' }));
  const list = [
    ...($('#showNotes').checked ? t.notes.filter(placed).map(n => ({ ...n, k: 'note', own: true, tag: 'private note' })) : []),
    ...($('#showQuestions').checked ? t.questions.filter(q => placed(q) && !['post', 'reply'].includes(kindOf(q))).map(q => ({ ...q, k: kindOf(q), own: true, tag: status[q.status] || q.status })) : []),
    ...closed,
  ];
  // a post with the replies under it; tap your own (post or reply) to edit it, another's to reply
  const edited = q => (q.edited_at ? ' <span class="st inline">(edited)</span>' : '');
  const repliesOf = q => (t.replies || []).filter(r => r.parent === q.id);
  const replies = q => { const rs = repliesOf(q); return rs.length ? `<div class="b-replies">${rs.map(r => `<div class="b-reply${yours(r) ? ' own' : ''}" data-id="${r.id}">↳ ${renderMixed(r.text)}${edited(r)}</div>`).join('')}</div>` : ''; };
  // on a phone: three lines until tapped open ("more" when something is cut off: text, replies, ...)
  const more = q => PHONE && (repliesOf(q).length || q.answer || yours(q) || q.text.length > 60);
  const note = (q, style = '') => `<div class="b-note${yours(q) ? ' own' : ''}${all || openNotes.has(q.id) ? ' open' : ''}${more(q) ? ' more' : ''}" data-id="${q.id}" title="${yours(q) ? 'Tap to edit your post · drag (or hold) to move it' : 'Tap to reply'}"${style}><div class="b-text">${renderMixed(q.text)}${edited(q)}</div>${yours(q) ? '<span class="st">yours · tap to edit, hold to move</span>' : ''}${replies(q)}${q.answer ? `<div class="reply"><b>Lecturer:</b> ${renderMixed(q.answer)}</div>` : ''}</div>`;
  const loose = open.filter(q => !placed(q));
  const { s, W, H } = geo;
  box.hidden = view === 'doc';
  box.innerHTML = open.filter(placed).map(q => note(q, ` style="--sc:${scOf()};left:${q.x * s}px;top:${q.y * s}px;transform:translate(${q.x * s > W * s - 250 * scOf() ? '-100%' : '0'},${q.y * s > H * s - 100 * scOf() ? '-100%' : '0'})"`)).join('')
    + (loose.length ? `<div class="b-col">${loose.map(q => note(q, ` style="--sc:${scOf()}"`)).join('')}</div>` : '')
    + list.map(p => `<div class="pin ${p.k}${p.status === 'answered' ? ' answered' : ''}${all || openPin === p.id ? ' expanded' : ''}" data-id="${p.id}" data-k="${p.k}" style="--sc:${p.k === 'note' ? 1 : scOf()};left:${p.x * geo.s}px;top:${p.y * geo.s}px">
      <button class="pin-dot" title="${esc(p.text)}">${KIND[p.k].icon}</button>
      <div class="pin-text">${renderMixed(p.text)}${edited(p)}<span class="st">${esc(p.tag)}</span>${p.answer ? `<div class="reply"><b>Lecturer:</b> ${renderMixed(p.answer)}</div>` : ''}${p.own ? `<button class="pin-edit" data-edit title="Edit it${p.k === 'note' ? '' : ', or make it a comment, question or post'} · drag (or hold) the dot to move it">✏️ Edit</button>` : ''}</div></div>`).join('');
  if (placing) box.querySelector(`[data-id="${placing.id}"]`)?.classList.add('placing-item');
  const hint = $('#boardHint');
  if (hint) {
    hint.hidden = !isBoardPage() || view === 'doc';
    // it fades after a few seconds (on a phone it would cover the posts); again on every new page
    if (!hint.hidden && hintPage !== cur) { hintPage = cur; hint.classList.remove('gone'); clearTimeout(hintTimer); hintTimer = setTimeout(() => hint.classList.add('gone'), 7000); }
  }
}
let hintPage = null, hintTimer = 0;
const isBoardPage = () => !!row?.board && row.page_no === cur;
const openNotes = new Set(); // phone: posts tapped open (all lines, replies)
let openPin = null;          // the pin whose text is open
$('#pins').addEventListener('click', e => {
  if (performance.now() < suppressUntil || placing) { e.stopPropagation(); return; } // the end of a hold, drag or move
  const ed = e.target.closest('[data-edit]');
  if (ed) { e.stopPropagation(); const it = itemOf(ed.closest('.pin')); if (it) openEdit(it, e.clientX, e.clientY); return; }
  const n = e.target.closest('.b-reply, .b-note');
  if (n) {
    e.stopPropagation();
    // a phone shows a post shortened: the first tap opens it, the next one replies / edits
    const b = e.target.closest('.b-note');
    if (b && b.classList.contains('more') && !b.classList.contains('open')) { openNotes.add(b.dataset.id); b.classList.add('open'); return; }
    openPostForm(n.dataset.id, e.clientX, e.clientY);
    return;
  }
  const pin = e.target.closest('.pin');
  if (!pin) return;
  e.stopPropagation();
  if ($('#openAll').checked) return; // all open anyway
  const was = pin.classList.contains('expanded');
  for (const p of $('#pins').querySelectorAll('.pin.expanded')) p.classList.remove('expanded');
  pin.classList.toggle('expanded', !was);
  openPin = was ? null : pin.dataset.id;
});

// save a note (private), comment or question (to the lecturer, anonymous); x, y = where on the page, or null
async function addMine(text, kind, x = null, y = null) {
  const at = x == null ? {} : { x: Math.round(x), y: Math.round(y) };
  if (kind === 'note') {
    const { error } = await sb.from('student_notes').insert({ lecture_id: lecture.id, page_no: cur, kind: 'text', text, ...at });
    if (error) throw error;
  } else {
    let { error } = await sb.from('questions').insert({ lecture_id: lecture.id, page_no: cur, text, kind, ...at });
    if (error && kind !== 'post' && /column|schema cache/i.test(error.message)) { // setup not re-run yet: send the text only
      ({ error } = await sb.from('questions').insert({ lecture_id: lecture.id, page_no: cur, text: kind === 'comment' ? 'Comment: ' + text : text }));
    }
    if (error && kind === 'post' && /kind_check|check constraint/i.test(error.message)) throw new Error('posts are not switched on in this course yet (the lecturer has to update the database)');
    if (error) throw error;
  }
  setNoteStatus(KIND[kind].done);
  await loadTyped(cur);
}
// tapping a post or a reply: your own → edit it; another's → reply under the post (everyone sees it)
let postTarget = null; // { id, edit, src, kind, newKind } while the form is open
function itemById(id, k) {
  const t = typed.get(cur) || {};
  if (k === 'note') { const n = (t.notes || []).find(x => x.id === id); return n ? { id, src: 'note', kind: 'note', own: true, q: n } : null; }
  const q = [...(t.questions || []), ...(t.posts || []), ...(t.replies || [])].find(x => x.id === id);
  return q ? { id, src: 'q', kind: kindOf(q), own: !q.student || q.student === me, q } : null;
}
const itemOf = el => (el ? itemById(el.dataset.id, el.dataset.k) : null);
function placeForm(f, clientX, clientY) {
  const w = f.offsetWidth, h = f.offsetHeight;
  f.style.left = Math.max(4, Math.min(clientX - 10, innerWidth - w - 4)) + 'px';
  f.style.top = Math.max(4, Math.min(clientY - 10, innerHeight - h - 4)) + 'px';
}
function openPostForm(id, clientX, clientY) {
  const it = itemById(id);
  if (!it) return;
  if (it.own) { openEdit(it, clientX, clientY); return; }
  const t = typed.get(cur) || {};
  const post = it.kind === 'reply' ? (t.posts || []).find(p => p.id === it.q.parent) : it.kind === 'post' ? it.q : null;
  if (!post) return;
  postTarget = { id: post.id, edit: false, page: cur };
  const f = $('#postForm');
  f.hidden = false;
  $('#postWhat').textContent = `Reply to: “${post.text.slice(0, 60)}${post.text.length > 60 ? '…' : ''}” (everyone sees it, anonymous)`;
  $('#postText').value = '';
  $('#postSend').textContent = '↩ Reply';
  $('#postKinds').hidden = true; $('#postKindNote').textContent = '';
  placeForm(f, clientX, clientY);
  $('#postText').focus();
}
// your own: the text, and for a comment, question or post also the type (a post with replies stays a post)
const SWITCH = ['comment', 'question', 'post'];
function openEdit(it, clientX, clientY) {
  if (!it?.own) return;
  const locked = it.kind === 'post' && (typed.get(cur)?.replies || []).some(r => r.parent === it.id);
  postTarget = { id: it.id, edit: true, page: cur, src: it.src, kind: it.kind, newKind: it.kind, locked };
  const f = $('#postForm');
  f.hidden = false;
  $('#postWhat').textContent = `Edit your ${it.kind === 'note' ? 'private note' : it.kind}`;
  $('#postText').value = it.q.text;
  $('#postSend').textContent = '💾 Save';
  $('#postKinds').hidden = !SWITCH.includes(it.kind);
  for (const b of $('#postKinds').querySelectorAll('[data-k]')) b.disabled = locked && b.dataset.k !== 'post';
  setEditKind(it.kind);
  placeForm(f, clientX, clientY);
  $('#postText').focus();
}
function setEditKind(k) {
  const tg = postTarget;
  if (!tg?.edit) return;
  tg.newKind = k;
  for (const b of $('#postKinds').querySelectorAll('[data-k]')) b.classList.toggle('sel', b.dataset.k === k);
  $('#postKindNote').textContent = !SWITCH.includes(tg.kind) ? '' : tg.locked ? 'This post has replies: it stays a post.'
    : k === 'post' ? 'A post: everyone in the lecture sees it (anonymous).' : `A ${k}: only the lecturer sees it (anonymous).`;
}
$('#postKinds').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b && !b.disabled) setEditKind(b.dataset.k); });
function closePostForm() { postTarget = null; const f = $('#postForm'); if (f) f.hidden = true; }
$('#postCancel').addEventListener('click', closePostForm);
$('#postText').addEventListener('keydown', e => {
  if (e.key === 'Escape') closePostForm();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#postForm').requestSubmit(); }
});
document.addEventListener('pointerdown', e => {
  if (!$('#postForm').hidden && !e.target.closest('#postForm, .b-note, .b-reply')) closePostForm();
});
$('#postForm').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#postText').value.trim(), tg = postTarget;
  if (!text || !tg || tg.page !== cur) { closePostForm(); return; }
  closePostForm();
  try {
    if (tg.edit && tg.src === 'note') {
      const { error } = await sb.from('student_notes').update({ text, updated_at: new Date().toISOString() }).eq('id', tg.id);
      if (error) throw error;
      setNoteStatus('note saved');
    } else if (tg.edit) {
      const change = tg.newKind !== tg.kind ? tg.newKind : null;
      let { error } = await sb.rpc('edit_mine', { item: tg.id, new_text: text, new_kind: change });
      if (error && /function|schema cache/i.test(error.message)) {
        // supabase-edit-move.sql not run yet: posts and replies can still be edited the old way (text only)
        if (!change && ['post', 'reply'].includes(tg.kind)) ({ error } = await sb.rpc('edit_post', { post: tg.id, new_text: text }));
        if (error) throw new Error(`${change ? 'changing the type' : 'editing this'} is not switched on in this course yet (the lecturer has to update the database)`);
      }
      if (error) throw error;
      setNoteStatus(!change ? `${tg.kind} saved` : change === 'post' ? 'now a post: everyone sees it' : `now a ${change}: only the lecturer sees it`);
    } else {
      const { error } = await sb.from('questions').insert({ lecture_id: lecture.id, page_no: cur, text, kind: 'reply', parent: tg.id });
      if (error) throw /kind_check|check constraint|parent|column|schema cache/i.test(error.message) ? new Error('replies are not switched on in this course yet (the lecturer has to update the database)') : error;
      setNoteStatus(KIND.reply.done);
    }
    await loadTyped(cur);
  } catch (err) {
    setNoteStatus((tg.edit ? 'not saved: ' : KIND.reply.fail) + (err.message || err));
  }
});
// in the side field: "P: ..." = post, "Q: ..." = question, "C: ..." = comment, anything else = private note
function parseTyped(raw) {
  const m = raw.match(/^([qcp])\s*[:;]\s*([\s\S]+)/i);
  return m ? { kind: { q: 'question', c: 'comment', p: 'post' }[m[1].toLowerCase()], text: m[2].trim() } : { kind: 'note', text: raw };
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
  // Enter = note (private), on a message board page a post; Shift+Enter = new line
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#placeForm').requestSubmit($(`#placeForm [data-kind=${isBoardPage() ? 'post' : 'note'}]`)); }
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
  if (placing && e.button === 0) { // "Move" from the menu: this tap is where it goes
    const it = placing, r = $('#sheet').getBoundingClientRect();
    stopPlacing();
    suppressUntil = performance.now() + 400; lastTap = null;
    moveItem(it, (e.clientX - r.left) / geo.s, (e.clientY - r.top) / geo.s);
    return;
  }
  if (noteMode || textMode || e.target.closest('.pin, .b-note, #postForm')) return;
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

// ----------------------------------------------------------------------------------- hold, right-click, move
// Finger and pen: hold still on a post, comment, question or note for HOLD ms. Your own lifts: drag it
// to move it, or let go without moving for the menu. Another's (or the empty page): the menu at once.
// Mouse: drag your own at once; right-click for the menu. The menu's "Move" asks for one tap where it
// should go (Esc, or a tap outside the page, cancels), so there is no mode to get out of.
// The lecturer sees the new place live (questions x, y; move_mine in supabase-edit-move.sql).
const HOLD = 450;
let hold = null, suppressUntil = 0, pinsPending = false, placing = null, ctxItem = null;
const movable = it => !!it?.own && it.kind !== 'reply';
let lastDown = { type: 'mouse', button: 0 };
document.addEventListener('pointerdown', e => {
  lastDown = { type: e.pointerType, button: e.button };
  if (!e.target.closest('#ctxMenu')) hideCtx();
  if (placing && !e.target.closest('#sheet')) { stopPlacing(); setNoteStatus('not moved'); }
}, true);
$('#sheet').addEventListener('pointerdown', e => {
  if (noteMode || textMode || placing || e.button !== 0 || view === 'doc') return;
  if (e.target.closest('.pin-edit, .tx-box, #postForm')) return;
  const el = e.target.closest('#pins .b-reply, #pins .b-note, #pins .pin');
  hold = { el, it: itemOf(el), pid: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, lifted: false, dragging: false, timer: 0 };
  if (e.pointerType !== 'mouse') hold.timer = setTimeout(holdFire, HOLD);
  else if (!movable(hold.it) || !el.matches('.b-note, .pin')) hold = null; // the mouse only drags your own
});
function holdFire() {
  const h = hold;
  if (!h) return;
  h.timer = 0;
  if (movable(h.it) && h.el.matches('.b-note, .pin')) { h.lifted = true; h.el.classList.add('lifted'); navigator.vibrate?.(15); return; }
  hold = null; suppressUntil = performance.now() + 600; lastTap = null;
  openCtx(h.x, h.y, h.it);
}
document.addEventListener('pointermove', e => {
  const h = hold;
  if (!h || e.pointerId !== h.pid) return;
  if (!h.dragging) {
    if (Math.hypot(e.clientX - h.x, e.clientY - h.y) < (h.type === 'mouse' ? 5 : 8)) return;
    if (h.type === 'mouse' ? !(e.buttons & 1) : !h.lifted) { clearTimeout(h.timer); hold = null; return; } // scrolling, not holding
    startDrag(h);
  }
  h.el.style.left = h.left0 + e.clientX - h.x + 'px';
  h.el.style.top = h.top0 + e.clientY - h.y + 'px';
});
// the finger must not scroll the page while it carries a note
document.addEventListener('touchmove', e => { if (hold?.lifted || hold?.dragging) e.preventDefault(); }, { passive: false });
function startDrag(h) {
  clearTimeout(h.timer);
  h.dragging = true;
  h.el.classList.remove('lifted');
  h.el.classList.add('dragging');
  closePostForm();
  if (h.el.closest('.b-col')) { // a post typed in the side field: out of the column, onto the page
    const p = $('#pins').getBoundingClientRect(), r = h.el.getBoundingClientRect();
    $('#pins').appendChild(h.el);
    Object.assign(h.el.style, { position: 'absolute', left: r.left - p.left + 'px', top: r.top - p.top + 'px', transform: 'none' });
  }
  h.left0 = parseFloat(h.el.style.left) || 0;
  h.top0 = parseFloat(h.el.style.top) || 0;
}
const endHold = e => {
  const h = hold;
  if (!h || e.pointerId !== h.pid) return;
  clearTimeout(h.timer);
  hold = null;
  if (h.dragging) {
    suppressUntil = performance.now() + 400; lastTap = null;
    h.el.classList.remove('dragging');
    if (e.type === 'pointercancel') { pinsPending = false; renderPins(); return; }
    // the new place, anchored the way renderPins anchors it (a note near the right / bottom edge hangs
    // from its right / bottom side), so it does not jump when drawn again
    const { s, W, H } = geo, p = $('#pins').getBoundingClientRect(), r = h.el.getBoundingClientRect();
    let x, y;
    if (h.el.matches('.pin')) { x = (r.left + r.width / 2 - p.left) / s; y = (r.top + r.height / 2 - p.top) / s; }
    else {
      const sc = scOf(), l = r.left - p.left, t = r.top - p.top;
      x = (l > W * s - 250 * sc ? l + r.width : l) / s;
      y = (t > H * s - 100 * sc ? t + r.height : t) / s;
    }
    moveItem(h.it, x, y);
    return;
  }
  if (h.lifted) {
    h.el.classList.remove('lifted');
    suppressUntil = performance.now() + 600; lastTap = null;
    if (e.type === 'pointerup') openCtx(h.x, h.y, h.it);
  }
};
document.addEventListener('pointerup', endHold);
document.addEventListener('pointercancel', endHold);

async function moveItem(it, x, y) {
  x = Math.round(Math.max(0, Math.min(geo.W, x)));
  y = Math.round(Math.max(0, Math.min(geo.H, y)));
  const was = { x: it.q.x, y: it.q.y };
  it.q.x = x; it.q.y = y; // here at once; the database tells the lecturer
  pinsPending = false;
  renderPins();
  try {
    if (it.src === 'note') {
      const { error } = await sb.from('student_notes').update({ x, y }).eq('id', it.id);
      if (error) throw error;
    } else {
      const { error } = await sb.rpc('move_mine', { item: it.id, nx: x, ny: y });
      if (error) throw /function|schema cache/i.test(error.message) ? new Error('moving is not switched on in this course yet (the lecturer has to update the database)') : error;
    }
    setNoteStatus('moved');
  } catch (err) {
    Object.assign(it.q, was);
    renderPins();
    setNoteStatus('not moved: ' + (err.message || err));
  }
}
function startPlacing(it) {
  placing = it;
  document.body.classList.add('placing');
  $(`#pins [data-id="${it.id}"]`)?.classList.add('placing-item');
  setNoteStatus('Tap the page where it should go (Esc: cancel)…');
}
function stopPlacing() {
  if (!placing) return;
  placing = null;
  document.body.classList.remove('placing');
  for (const el of document.querySelectorAll('.placing-item')) el.classList.remove('placing-item');
  setNoteStatus('');
}

// the menu: what can be done with the one under the finger / mouse, and for all of them
const anyShown = () => ['showPosts', 'showQuestions', 'showNotes'].some(id => $('#' + id).checked);
function openCtx(cx, cy, it) {
  const m = $('#ctxMenu'), all = $('#openAll').checked;
  const rows = [];
  if (it) {
    rows.push(`<div class="what">${KIND[it.kind].icon} ${esc(it.q.text.slice(0, 50))}</div>`);
    if (it.own) {
      rows.push(`<button data-c="edit">✏️ Edit${SWITCH.includes(it.kind) ? ' / change the type' : ''}</button>`);
      if (movable(it)) rows.push('<button data-c="move">✥ Move</button>');
    } else if (['post', 'reply'].includes(it.kind)) rows.push('<button data-c="reply">↩ Reply</button>');
    rows.push('<hr>');
  }
  rows.push(`<button data-c="openall">${all ? '▣ Close all comments' : '▤ Show all comments (open)'}</button>`);
  rows.push(`<button data-c="hide">${anyShown() ? '🙈 Hide comments' : '👁 Show comments'}</button>`);
  m.innerHTML = rows.join('');
  ctxItem = it;
  m.hidden = false;
  m.style.left = Math.max(4, Math.min(cx, innerWidth - m.offsetWidth - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(cy, innerHeight - m.offsetHeight - 4)) + 'px';
}
function hideCtx() { const m = $('#ctxMenu'); if (m && !m.hidden) { m.hidden = true; ctxItem = null; } }
$('#ctxMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  const it = ctxItem, r = $('#ctxMenu').getBoundingClientRect(), c = b.dataset.c;
  hideCtx();
  if (c === 'edit') openEdit(it, r.left, r.top);
  else if (c === 'reply') openPostForm(it.id, r.left, r.top);
  else if (c === 'move') startPlacing(it);
  else if (c === 'openall') { $('#openAll').checked = !$('#openAll').checked; showChanged(); }
  else if (c === 'hide') { const on = !anyShown(); for (const id of ['showPosts', 'showQuestions', 'showNotes']) $('#' + id).checked = on; showChanged(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideCtx(); if (placing) { stopPlacing(); setNoteStatus('not moved'); } } });
function renderMine() {
  const t = typed.get(cur) || { notes: [], questions: [] };
  const status = { open: 'sent', answered: 'answered', hidden: 'seen' };
  const where = x => (x.x != null ? ' · 📍 on the page' : '');
  $('#myList').innerHTML = [
    ...t.questions.map(q => `<div class="my ${kindOf(q)}">${{ post: '📌', reply: '↩', comment: '💬', question: '❓' }[kindOf(q)]} ${renderMixed(q.text)}<span class="st">${['post', 'reply'].includes(kindOf(q)) ? (q.status === 'hidden' ? 'removed by the lecturer' : kindOf(q) === 'reply' ? 'reply for everyone' : 'posted for everyone') : status[q.status] || q.status}${where(q)}</span>${q.answer ? `<div class="reply"><b>Lecturer:</b> ${renderMixed(q.answer)}</div>` : ''}</div>`),
    ...t.notes.map(x => `<div class="my">📝 ${renderMixed(x.text)}${x.x != null ? '<span class="st">📍 on the page</span>' : ''}</div>`),
  ].join('');
}
$('#noteForm').addEventListener('submit', async e => {
  e.preventDefault();
  const raw = $('#noteText').value.trim();
  if (!lecture) return;
  if (!raw) { $('#noteText').focus(); setNoteStatus('Type a note first (start with P: for a post everyone sees, C: for a comment or Q: for a question to the lecturer)'); return; }
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
$('#viewBtn').addEventListener('click', e => { e.stopPropagation(); $('#cmtMenu').hidden = true; $('#viewMenu').hidden = !$('#viewMenu').hidden; });
document.addEventListener('click', e => {
  if (!e.target.closest('#viewWrap')) $('#viewMenu').hidden = true;
  if (!e.target.closest('#cmtWrap')) $('#cmtMenu').hidden = true;
});
$('#viewMenu').addEventListener('change', e => { if (e.target.name === 'view') setView(e.target.value); });
// the 💬 Comments menu: everyone's posts, your comments & questions, your notes: shown or hidden; open all
$('#cmtBtn').addEventListener('click', e => { e.stopPropagation(); $('#viewMenu').hidden = true; $('#cmtMenu').hidden = !$('#cmtMenu').hidden; });
$('#cmtMenu').addEventListener('change', showChanged);
function showChanged() {
  LS.set('ink2latex.viewer.show', { notes: $('#showNotes').checked, questions: $('#showQuestions').checked, posts: $('#showPosts').checked, all: $('#openAll').checked });
  $('#cmtBtn').classList.toggle('off', !anyShown());
  if (!lecture) return;
  renderNotes(); renderPins(); myText.setHidden(!$('#showNotes').checked);
}
$('#leave').addEventListener('click', leave);
// full screen: the page alone, a small floating bar at the left (fullscreen.js)
const fullscreen = initFullscreen({
  toolbar: $('#bar'),
  hide: [$('#side')],
  menuOpen: () => !$('#viewMenu').hidden || !$('#cmtMenu').hidden,
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
{
  const sh = LS.get('ink2latex.viewer.show');
  if (sh) { $('#showNotes').checked = sh.notes !== false; $('#showQuestions').checked = sh.questions !== false; $('#showPosts').checked = sh.posts !== false; $('#openAll').checked = !!sh.all; }
  $('#cmtBtn').classList.toggle('off', !anyShown());
}

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
