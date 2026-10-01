// Ink board: an A4 page (portrait or landscape) of pressure-sensitive strokes (perfect-freehand),
// with eraser, lasso grouping, undo/redo and hold-to-snap shapes.
// Strokes are stored in page units {id, pts:[[x,y,pressure]], size, color, pen, shape};
// the page is scaled to fit the width of its container and scrolls vertically.

import { getStroke } from 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.3/+esm';
import { recognize } from './shapes.js?v=2026-10-01.1238';

// A4 (ratio 1 : sqrt 2) in both orientations, and 16:9 for slides and screens
export const PAGE = { portrait: [1200, 1697], landscape: [1697, 1200], wide: [1920, 1080] };

const HOLD_MS = 600;      // hold the pen still this long to snap the current stroke to a shape
const HOLD_TOL = 3;       // page units of jitter allowed while holding
const ERASER_R = 10;
const LASER_MS = 350;       // how long the laser spot's short trail stays while hovering
const LASER_FADE_MS = 5000; // how long a trace drawn with the laser takes to fade away

const avg = (a, b) => (a + b) / 2;
function svgPath(points) {
  const len = points.length;
  if (len < 4) return '';
  let a = points[0], b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0]).toFixed(2)},${avg(b[1], c[1]).toFixed(2)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = points[i]; b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(2)},${avg(a[1], b[1]).toFixed(2)} `;
  }
  return d + 'Z';
}

export function strokeOptions(s, last = true) {
  return {
    size: s.size,
    thinning: s.shape ? 0 : s.size < 2 ? 0.15 : 0.55, // hairlines stay visible at light pressure
    smoothing: 0.5,
    // streamline evens out shaky input but makes the line trail the pen; a real pen is smooth already
    streamline: s.shape ? 0 : s.pen ? 0.15 : 0.4,
    simulatePressure: !s.pen && !s.shape,
    last,
  };
}

export function strokePath(s, last = true) {
  if (last && s._path) return s._path;
  const outline = getStroke(s.pts, strokeOptions(s, last));
  let p;
  if (outline.length < 4) {
    p = new Path2D(); // a dot
    const [x, y] = s.pts[0];
    p.arc(x, y, s.size / 2, 0, Math.PI * 2);
  } else {
    p = new Path2D(svgPath(outline));
  }
  if (last) s._path = p;
  return p;
}

export function strokeBox(s) {
  if (s._box) return s._box;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of s.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const r = s.size / 2;
  return (s._box = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r });
}

export function unionBox(boxes) {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const o of boxes) { b.x0 = Math.min(b.x0, o.x0); b.y0 = Math.min(b.y0, o.y0); b.x1 = Math.max(b.x1, o.x1); b.y1 = Math.max(b.y1, o.y1); }
  return b;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Render strokes black-on-white into a PNG for the model.
// labels: [{box, n}] draws numbered red region boxes (used for whole-board interpretation).
export function renderCrop(strokes, maxDim = 1024, labels = [], area = null) {
  const box = area || unionBox(strokes.map(strokeBox));
  const pad = area ? 0 : 16;
  const w = box.x1 - box.x0 + 2 * pad, h = box.y1 - box.y0 + 2 * pad;
  const scale = Math.min(maxDim / Math.max(w, h), 2.5);
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, cw, ch);
  g.setTransform(scale, 0, 0, scale, (pad - box.x0) * scale, (pad - box.y0) * scale);
  g.fillStyle = '#000';
  for (const s of strokes) g.fill(strokePath(s));
  g.setTransform(1, 0, 0, 1, 0, 0);
  for (const { box: b, n } of labels) {
    const x = (b.x0 - box.x0 + pad) * scale - 4, y = (b.y0 - box.y0 + pad) * scale - 4;
    const bw = (b.x1 - b.x0) * scale + 8, bh = (b.y1 - b.y0) * scale + 8;
    g.strokeStyle = 'rgba(220, 0, 0, 0.55)';
    g.lineWidth = 1.5;
    g.strokeRect(x, y, bw, bh);
    g.fillStyle = 'rgb(220, 0, 0)';
    g.font = 'bold 15px sans-serif';
    g.fillText(String(n), x + 2, Math.max(14, y - 3));
  }
  const url = c.toDataURL('image/png');
  // map: image pixel -> page units is  x / scale + ox
  return { image: url.split(',')[1], mediaType: 'image/png', width: cw, height: ch, dataUrl: url,
    map: { scale, ox: box.x0 - pad, oy: box.y0 - pad } };
}

// Full page image for printing (always dark ink on white)
export function renderPageImage(strokes, pageW, pageH, palette, scale = 2) {
  const c = document.createElement('canvas');
  c.width = pageW * scale; c.height = pageH * scale;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.setTransform(scale, 0, 0, scale, 0, 0);
  for (const s of strokes) { g.fillStyle = palette[s.color] || s.color; g.fill(strokePath(s)); }
  return c.toDataURL('image/png');
}

export class Board {
  constructor(canvas, { onCommit, onSnap, onSelect, onTransform } = {}) {
    this.canvas = canvas;
    this.sheet = canvas.parentElement;          // sized to the page
    this.wrap = this.sheet.parentElement;        // scroll container
    this.ctx = canvas.getContext('2d');
    // The page (all finished strokes) is painted only when it changes; the stroke being written,
    // the lasso and the eraser cursor go on a transparent layer on top, so following the pen does
    // not repaint the whole page on every movement.
    this.live = document.createElement('canvas');
    this.live.className = 'live-layer';
    this.live.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
    canvas.after(this.live);
    this.lctx = this.live.getContext('2d');
    this.fullDirty = true;
    this.resetStats();
    this.onCommit = onCommit || (() => {});
    this.onSnap = onSnap || (() => {});
    this.onSelect = onSelect || (() => {});        // selection changed (or moved): sel | null
    this.onTransform = onTransform || (() => {});  // selected strokes were moved/resized
    this.sel = null;                               // {ids:Set, box}
    this.pickAt = null;                            // p -> stroke ids of the region under p (Select tool)
    this.pickPartAt = null;                        // p -> stroke ids of the piece of a group under p (Alt)
    this.onHover = null;                           // p | null while the pen/mouse hovers without drawing
    this.onTap = null;                             // selection clicked without moving
    this.penButton = 'erase';                      // pen side button: 'erase' | 'scroll'
    this.onDoubleTap = null;                       // p: double tap / double click on the page
    this.lastTap = null;
    // double click with the Select or Eraser tool (the pen tool detects double taps itself, see up())
    canvas.addEventListener('dblclick', e => { if (this.tool !== 'pen') this.onDoubleTap?.(this.point(e)); });
    this.hiddenIds = new Set();                    // strokes not drawn (typeset view)
    this.dimIds = new Set();                       // strokes drawn faded (ink + typeset view)
    this.errorMarks = [];                          // [{x0,y0,x1,y1, coarse}] translucent red marks
    this.page = { strokes: [], undo: [], redo: [] };
    this.seq = 0;
    this.tool = 'pen';
    this.color = 'auto';
    this.size = 4.5;
    this.snap = true;
    this.palette = { auto: '#1b1b1b' };
    this.bg = '#ffffff';
    this.active = null;
    this.hover = null;
    this.penSeen = false;
    this.highlight = null;
    [this.pageW, this.pageH] = PAGE.portrait;
    this.s = 1;
    this.zoom = 1;       // 1 = page fits the width of the window; < 1 shows the page smaller (more room)
    this.onZoom = null;
    this.trail = [];     // recent hover points [x, y, time] for the laser pointer
    this.lasers = [];    // laser traces [[x, y, time], ...], fading over LASER_FADE_MS

    // Ctrl + wheel zooms
    this.wrap.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.resize();

    // holding Ctrl with the pen erases: show the eraser circle as soon as Ctrl is down
    window.addEventListener('keydown', e => { if (e.key === 'Control') this.setCtrl(true); });
    window.addEventListener('keyup', e => { if (e.key === 'Control') this.setCtrl(false); });
    window.addEventListener('blur', () => this.setCtrl(false));

    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    // onIdle: the pen has lifted; work that was held back while writing can run now
    const lift = e => { const was = !!this.active; this.up(e); if (was && !this.active) { this.lastUp = performance.now(); this.onIdle?.(); } };
    canvas.addEventListener('pointerup', lift);
    canvas.addEventListener('pointercancel', lift);
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.trail = []; this.onHover?.(null); this.request(); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  get strokes() { return this.page.strokes; }

  setCtrl(on) {
    if (!!this.ctrlHeld === on) return;
    this.ctrlHeld = on;
    if (!this.active) this.canvas.style.cursor = this.cursorNow();
    this.requestLive();
  }
  // no system pointer where the board draws its own (eraser circle, laser spot)
  cursorNow() { return this.ctrlHeld && this.tool === 'pen' ? 'none' : this.baseCursor || ''; }

  setPage(page) {
    this.page = page;
    for (const s of page.strokes) this.seq = Math.max(this.seq, s.id);
    this.request();
  }

  // 'portrait' | 'landscape' | [width, height]
  setPageSize(o) {
    [this.pageW, this.pageH] = Array.isArray(o) ? o : PAGE[o] || PAGE.portrait;
    this.resize();
  }

  resize() {
    const avail = Math.max(200, this.wrap.clientWidth - 24);
    this.s = (avail / this.pageW) * this.zoom;
    const w = this.pageW * this.s, h = this.pageH * this.s;
    const dpr = window.devicePixelRatio || 1;
    this.sheet.style.width = w + 'px';
    this.sheet.style.height = h + 'px';
    for (const c of [this.canvas, this.live]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.dpr = dpr;
    this.request();
    this.onResize?.();
  }

  setZoom(z) {
    this.zoom = Math.max(0.3, Math.min(3, z));
    this.resize();
    this.onZoom?.(this.zoom);
  }

  // Scale and move all strokes so they lie within the page margins (undoable). Returns true if anything changed.
  fitToPage(margin = 40) {
    const st = this.page.strokes;
    if (!st.length) return false;
    const b = unionBox(st.map(strokeBox));
    const W = this.pageW - 2 * margin, H = this.pageH - 2 * margin;
    const f = Math.min(1, W / (b.x1 - b.x0), H / (b.y1 - b.y0));
    // new top-left: keep the content where it is if it already fits, otherwise pull it inside the margins
    const nx = Math.min(Math.max(b.x0, margin), margin + W - (b.x1 - b.x0) * f);
    const ny = Math.min(Math.max(b.y0, margin), margin + H - (b.y1 - b.y0) * f);
    if (f === 1 && nx === b.x0 && ny === b.y0) return false;
    this.clearSelection();
    this.applyEdits(st.map(s => ({
      s,
      after: { pts: s.pts.map(([x, y, p]) => [nx + (x - b.x0) * f, ny + (y - b.y0) * f, p]), shape: s.shape, size: s.size * f },
    })));
    return true;
  }

  setTheme(bg, palette) { this.bg = bg; this.palette = palette; this.request(); }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return [(e.clientX - r.left) / this.s, (e.clientY - r.top) / this.s, p];
  }

  // pen side button: 'erase' (erases while held) or 'scroll' (drag scrolls the page)
  penButtonDown(e) { return e.pointerType === 'pen' && (e.button === 2 || (e.buttons & 2) === 2); }

  isEraser(e) {
    return this.tool === 'eraser' || e.button === 5 || (e.buttons & 32) === 32
      || (e.ctrlKey && this.tool === 'pen')                                 // hold Ctrl to erase
      || (this.penButton !== 'scroll' && this.penButtonDown(e));
  }

  isPan(e) {
    if (e.button === 1 || (e.buttons & 4) === 4) return true;               // middle button
    if (this.penButtonDown(e)) return this.penButton === 'scroll';
    return e.pointerType === 'mouse' && (e.button === 2 || (e.buttons & 2) === 2); // right mouse button
  }

  down(e) {
    if (e.pointerType === 'pen') this.penSeen = true;
    if (e.pointerType === 'touch' && this.penSeen) return; // palm rejection
    if (this.active) return;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (this.isPan(e)) {
      // middle button, right mouse button, or the pen side button in 'scroll' mode: drag scrolls the page
      const sc = this.wrap.scrollHeight > this.wrap.clientHeight + 1 ? this.wrap : document.scrollingElement;
      this.active = { id: e.pointerId, pan: { sc, y: e.clientY, x: e.clientX, top: sc.scrollTop, left: sc.scrollLeft } };
      return;
    }
    const p = this.point(e);
    this.onHover?.(null);
    if (this.tool !== 'lasso') this.clearSelection();
    if (this.tool === 'lasso' && !this.isEraser(e)) {
      const hitSel = this.sel && this.selHit(p);
      const region = !hitSel && this.pickAt ? this.pickAt(p) : null;
      const piece = e.altKey && this.pickPartAt ? this.pickPartAt(p) : null;
      if (piece && piece.length) {
        // Alt + press: grab just the piece of a group under the pen and move it
        this.selectIds(piece);
        this.startDrag(e.pointerId, 'move', p);
        this.active.fresh = true;
      } else if (region && region.length && this.sel && (e.shiftKey || e.ctrlKey)) {
        // Shift/Ctrl + click on a region adds it to the selection (then Group merges them)
        this.selectIds([...this.sel.ids, ...region]);
      } else if (hitSel) {
        this.startDrag(e.pointerId, hitSel, p);
      } else if (region && region.length) {
        // pressing inside a region's box selects the whole region and starts moving it
        this.selectIds(region);
        this.startDrag(e.pointerId, 'move', p);
        this.active.fresh = true;
      } else {
        this.clearSelection();
        this.active = { id: e.pointerId, lasso: [p] };
      }
    } else if (this.tool === 'laser' && !this.isEraser(e)) {
      // laser pointer: a red trace that fades away, not ink (never saved, not sent)
      this.active = { id: e.pointerId, laser: [[p[0], p[1], performance.now()]] };
      this.trail = [];
    } else if (this.isEraser(e)) {
      this.active = { id: e.pointerId, eraser: true, removed: [] };
      this.canvas.style.cursor = 'none'; // the tinted circle shows where it erases (also Ctrl / eraser end)
      this.eraseAt(p);
    } else {
      this.active = { id: e.pointerId, t0: performance.now(), stroke: { id: ++this.seq, pts: [p], size: this.size, color: this.color, pen: e.pointerType === 'pen', shape: null } };
      if (this.pencilImg) this.canvas.style.cursor = 'none'; // the board draws the pencil while writing
      this.hover = p;
      this.armHold(p);
    }
    this.request();
  }

  move(e) {
    const a = this.active;
    this.hover = this.point(e);
    if (e.ctrlKey !== !!this.ctrlHeld) this.setCtrl(e.ctrlKey);
    if (!a || e.pointerId !== a.id) {
      if (!a) this.onHover?.(this.hover);
      if (this.tool === 'eraser' || (this.ctrlHeld && this.tool === 'pen')) this.requestLive();
      else if (this.tool === 'laser' && !a) { this.trail.push([this.hover[0], this.hover[1], performance.now()]); this.requestLive(); }
      return;
    }
    if (a.pan) {
      a.pan.sc.scrollTop = a.pan.top - (e.clientY - a.pan.y);
      a.pan.sc.scrollLeft = a.pan.left - (e.clientX - a.pan.x);
      return;
    }
    if (a.mode) { this.dragSelection(this.point(e)); return; }
    if (a.laser) { const now = performance.now(); for (const ev of (e.getCoalescedEvents?.() || [e])) { const p = this.point(ev); a.laser.push([p[0], p[1], now]); } this.requestLive(); return; }
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const st = this.stats; // for the diagnostics panel (Ctrl+Shift+D)
    st.events++; st.points += events.length || 1; st.types[e.pointerType] = (st.types[e.pointerType] || 0) + 1;
    st.lastEventTs = e.timeStamp; st.pressure = e.pressure;
    for (const ev of (events.length ? events : [e])) {
      const p = this.point(ev);
      if (a.lasso) { a.lasso.push(p); continue; }
      if (a.eraser) { this.eraseAt(p); continue; }
      if (a.stroke.shape) continue; // already snapped: ignore further movement
      a.stroke.pts.push(p);
      if (Math.hypot(p[0] - a.holdAt[0], p[1] - a.holdAt[1]) > HOLD_TOL) this.armHold(p);
    }
    // erasing changes the page; writing and lassoing only the layer on top
    if (a.eraser) this.request(); else this.requestLive();
  }

  up(e) {
    const a = this.active;
    if (!a || e.pointerId !== a.id) return;
    clearTimeout(a.holdTimer);
    this.active = null;
    if ((a.eraser || a.stroke) && this.baseCursor) { this.canvas.style.cursor = this.cursorNow(); this.requestLive(); }
    if (a.laser) { this.lasers.push(a.laser); this.requestLive(); return; } // keeps fading on its own
    if (a.pan) return;
    // a pen or finger tap wobbles more than a mouse click: up to ~10 screen px still counts as a tap
    const tapTol = (e.pointerType === 'mouse' ? 3 : 10) / this.s;
    if (a.mode && (!a.last || Math.hypot(a.last[0] - a.start[0], a.last[1] - a.start[1]) < tapTol)) {
      // a click, not a drag: undo any jitter and report the tap
      for (const s of a.strokes) this.setGeom(s, a.orig.get(s.id));
      this.sel.box = a.box0;
      this.onTap?.(a.start, !!a.fresh);
      this.request();
      return;
    }
    if (a.mode) {
      const moved = a.strokes.filter(s => s.pts !== a.orig.get(s.id).pts);
      if (moved.length) {
        const changes = moved.map(s => ({ s, before: a.orig.get(s.id), after: { pts: s.pts, shape: s.shape, size: s.size } }));
        this.push({ type: 'edit', changes }, 'transform');
        this.onTransform(moved);
      }
    } else if (a.lasso) {
      const poly = a.lasso;
      const hit = this.page.strokes.filter(s => {
        const inside = s.pts.filter(p => insidePolygon(p, poly)).length;
        return inside >= 0.6 * s.pts.length;
      });
      if (hit.length) {
        this.sel = { ids: new Set(hit.map(s => s.id)), box: unionBox(hit.map(strokeBox)) };
        this.onSelect(this.sel);
      }
    } else if (a.eraser) {
      if (a.removed.length) this.push({ type: 'remove', strokes: a.removed }, 'erase');
    } else {
      const st = a.stroke;
      // a tap: very short in time and space. Two taps on the same spot = double tap (no dots are kept).
      const p0 = st.pts[0];
      // (tolerant of the small slip a pen makes when it touches down)
      const isTap = performance.now() - a.t0 < 350 && st.pts.every(q => Math.hypot(q[0] - p0[0], q[1] - p0[1]) < 8 / this.s);
      if (isTap) {
        const now = performance.now(), lt = this.lastTap;
        if (lt && now - lt.t < 450 && Math.hypot(p0[0] - lt.p[0], p0[1] - lt.p[1]) < 14 / this.s) {
          this.lastTap = null;
          this.removeTapDot(lt.stroke);
          this.request();
          this.onDoubleTap?.(p0);
          return;
        }
        this.lastTap = { t: now, p: p0, stroke: st };
      } else {
        this.lastTap = null;
      }
      this.page.strokes.push(st);
      this.push({ type: 'add', strokes: [st] }, 'add');
    }
    this.request();
  }

  // take back the dot left by the first tap of a double tap (it is the latest stroke)
  removeTapDot(s) {
    const i = this.page.strokes.indexOf(s);
    if (i >= 0) this.page.strokes.splice(i, 1);
    const top = this.page.undo[this.page.undo.length - 1];
    if (top && top.type === 'add' && top.strokes[0] === s) this.page.undo.pop();
  }

  // ---- selection (lasso tool): move by dragging inside, resize with the bottom-right handle
  selStrokes() { return this.sel ? this.page.strokes.filter(s => this.sel.ids.has(s.id)) : []; }

  selHit(p) {
    const b = this.sel.box, pad = 8, h = 16 / this.s;
    if (Math.abs(p[0] - (b.x1 + pad)) < h && Math.abs(p[1] - (b.y1 + pad)) < h) return 'scale';
    if (p[0] > b.x0 - pad && p[0] < b.x1 + pad && p[1] > b.y0 - pad && p[1] < b.y1 + pad) return 'move';
    return null;
  }

  selectIds(ids) {
    const set = new Set(ids);
    const st = this.page.strokes.filter(s => set.has(s.id));
    if (!st.length) return;
    this.sel = { ids: set, box: unionBox(st.map(strokeBox)) };
    this.onSelect(this.sel);
    this.request();
  }

  startDrag(pointerId, mode, p) {
    const strokes = this.selStrokes();
    const orig = new Map(strokes.map(s => [s.id, { pts: s.pts, shape: s.shape, size: s.size }]));
    this.active = { id: pointerId, mode, start: p, orig, strokes, box0: { ...this.sel.box } };
  }

  // start moving the given strokes with a pointer that went down outside the canvas (region badge)
  dragFromOutside(e, ids) {
    if (this.active) return;
    this.selectIds(ids);
    if (!this.sel) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.startDrag(e.pointerId, 'move', this.point(e));
  }

  dragSelection(p) {
    const a = this.active, b0 = a.box0;
    a.last = p;
    let f = 1, dx = 0, dy = 0;
    if (a.mode === 'move') { dx = p[0] - a.start[0]; dy = p[1] - a.start[1]; }
    else {
      const d0 = (a.start[0] - b0.x0) + (a.start[1] - b0.y0);
      f = Math.max(0.15, Math.min(8, ((p[0] - b0.x0) + (p[1] - b0.y0)) / Math.max(1, d0)));
    }
    for (const s of a.strokes) {
      const o = a.orig.get(s.id);
      s.pts = o.pts.map(([x, y, pr]) => [b0.x0 + (x - b0.x0) * f + dx, b0.y0 + (y - b0.y0) * f + dy, pr]);
      s.size = o.size * f;
      s._path = null; s._box = null;
    }
    this.sel.box = { x0: b0.x0 + dx, y0: b0.y0 + dy, x1: b0.x0 + (b0.x1 - b0.x0) * f + dx, y1: b0.y0 + (b0.y1 - b0.y0) * f + dy };
    this.onSelect(this.sel);
    this.request();
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel = null;
    this.onSelect(null);
    this.request();
  }

  deleteSelection() {
    const del = this.selStrokes();
    this.clearSelection();
    if (!del.length) return;
    const ids = new Set(del.map(s => s.id));
    this.page.strokes = this.page.strokes.filter(s => !ids.has(s.id));
    this.push({ type: 'remove', strokes: del }, 'erase');
    this.request();
  }

  push(act, kind) {
    this.page.undo.push(act);
    this.page.redo = [];
    this.onCommit(kind);
  }

  armHold(p) {
    const a = this.active;
    clearTimeout(a.holdTimer);
    a.holdAt = p;
    if (!this.snap) return;
    a.holdTimer = setTimeout(() => {
      if (this.active !== a || !a.stroke || a.stroke.shape) return;
      const r = recognize(a.stroke.pts);
      if (!r) return;
      a.stroke.raw = a.stroke.pts;
      a.stroke.pts = r.pts;
      a.stroke.shape = r.type;
      this.onSnap(r.type, p);
      this.request();
    }, HOLD_MS);
  }

  eraseAt(p) {
    const list = this.page.strokes;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const b = strokeBox(s);
      const r = ERASER_R + s.size / 2;
      if (p[0] < b.x0 - r || p[0] > b.x1 + r || p[1] < b.y0 - r || p[1] > b.y1 + r) continue;
      let hit = s.pts.length === 1 && Math.hypot(p[0] - s.pts[0][0], p[1] - s.pts[0][1]) < r;
      for (let k = 1; k < s.pts.length && !hit; k++) hit = segDist(p, s.pts[k - 1], s.pts[k]) < r;
      if (hit) { list.splice(i, 1); this.active.removed.push(s); }
    }
  }

  // changes: [{s, after:{pts, shape}}] - replaces stroke geometry in place (ids unchanged), undoable
  applyEdits(changes) {
    if (!changes.length) return;
    for (const c of changes) {
      c.before = { pts: c.s.pts, shape: c.s.shape, size: c.s.size };
      this.setGeom(c.s, c.after);
    }
    this.push({ type: 'edit', changes }, 'edit');
    this.request();
  }

  setGeom(s, g) { s.pts = g.pts; s.shape = g.shape; if (g.size) s.size = g.size; s._path = null; s._box = null; }

  undo() { this.step(this.page.undo, this.page.redo, true); }
  redo() { this.step(this.page.redo, this.page.undo, false); }

  step(from, to, isUndo) {
    const act = from.pop();
    if (!act) return;
    this.clearSelection();
    if (act.type === 'edit') {
      for (const c of act.changes) this.setGeom(c.s, isUndo ? c.before : c.after);
    } else if ((act.type === 'add') !== isUndo) {
      this.page.strokes.push(...act.strokes);
      this.page.strokes.sort((x, y) => x.id - y.id);
    } else {
      const ids = new Set(act.strokes.map(s => s.id));
      this.page.strokes = this.page.strokes.filter(s => !ids.has(s.id));
    }
    to.push(act);
    this.onCommit(isUndo ? 'undo' : 'redo');
    this.request();
  }

  clear() {
    if (!this.page.strokes.length) return;
    const all = this.page.strokes.slice();
    this.page.strokes = [];
    this.push({ type: 'remove', strokes: all }, 'clear');
    this.request();
  }

  // request(): the page changed (repaint everything); requestLive(): only the layer on top changed
  request() {
    this.fullDirty = true;
    this.requestLive();
  }

  requestLive() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const st = this.stats, t0 = performance.now();
      if (this.fullDirty) { this.fullDirty = false; this.renderPage(); st.pageMs += performance.now() - t0; st.pageFrames++; }
      const t1 = performance.now();
      this.renderLive();
      const t2 = performance.now();
      st.liveMs += t2 - t1; st.frames++;
      // pen reported a position -> that position drawn
      if (this.active?.stroke && st.lastEventTs) { st.lat += t2 - st.lastEventTs; st.latN++; st.latMax = Math.max(st.latMax, t2 - st.lastEventTs); }
    });
  }

  resetStats() {
    this.stats = { events: 0, points: 0, types: {}, frames: 0, pageFrames: 0, pageMs: 0, liveMs: 0, lat: 0, latN: 0, latMax: 0, lastEventTs: 0, pressure: 0 };
  }

  colorOf(s) { return (this.palette && this.palette[s.color]) || s.color; }

  render() { this.renderPage(); this.renderLive(); }

  renderPage() {
    const g = this.ctx;
    g.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, 0, 0);
    // slides and figures live on their own layer under this canvas (app.js); then this one stays
    // transparent and only the ink is redrawn here
    if (this.underlay?.(this.page)) {
      g.clearRect(0, 0, this.pageW, this.pageH);
    } else {
      g.fillStyle = this.bg;
      g.fillRect(0, 0, this.pageW, this.pageH);
    }
    if (this.highlight) {
      const b = this.highlight;
      g.fillStyle = 'rgba(255, 196, 0, 0.16)';
      g.fillRect(b.x0 - 6, b.y0 - 6, b.x1 - b.x0 + 12, b.y1 - b.y0 + 12);
    }
    for (const s of this.page.strokes) {
      if (this.hiddenIds.has(s.id)) continue;
      g.globalAlpha = this.dimIds.has(s.id) ? 0.2 : 1;
      g.fillStyle = this.colorOf(s);
      g.fill(strokePath(s));
    }
    g.globalAlpha = 1;
    for (const m of this.errorMarks) {
      // coarse = whole region while the exact spot is being located; fine = the problematic symbols
      const pad = m.coarse ? 8 : 4;
      g.fillStyle = m.coarse ? 'rgba(229, 57, 53, 0.10)' : 'rgba(229, 57, 53, 0.28)';
      g.fillRect(m.x0 - pad, m.y0 - pad, m.x1 - m.x0 + 2 * pad, m.y1 - m.y0 + 2 * pad);
      g.strokeStyle = 'rgba(229, 57, 53, 0.8)';
      g.lineWidth = 1.5 / this.s;
      g.setLineDash(m.coarse ? [5 / this.s, 4 / this.s] : []);
      g.strokeRect(m.x0 - pad, m.y0 - pad, m.x1 - m.x0 + 2 * pad, m.y1 - m.y0 + 2 * pad);
      g.setLineDash([]);
    }
    if (this.sel) {
      const b = this.sel.box, pad = 8;
      g.save();
      g.setLineDash([6 / this.s, 4 / this.s]);
      g.strokeStyle = '#ff9800';
      g.lineWidth = 1.5 / this.s;
      g.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
      g.setLineDash([]);
      g.fillStyle = '#ff9800';
      const h = 7 / this.s;
      g.fillRect(b.x1 + pad - h, b.y1 + pad - h, 2 * h, 2 * h);
      g.restore();
    }
  }

  // Laser pointer while the pen only hovers: a glowing red dot with a short trail that fades within
  // LASER_MS. Keeps redrawing only while the trail is fading, then stops.
  drawLaser(g) {
    const now = performance.now();
    this.trail = this.trail.filter(q => now - q[2] < LASER_MS).slice(-40);
    const u = 1 / this.s; // one screen pixel in page units
    g.save();
    g.lineCap = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const [x0, y0] = this.trail[i - 1], [x1, y1, t] = this.trail[i];
      const k = 1 - (now - t) / LASER_MS; // 1 = new, 0 = gone
      g.strokeStyle = `rgba(255, 40, 40, ${0.55 * k})`;
      g.lineWidth = (2 + 5 * k) * u;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    const [x, y] = this.hover;
    g.shadowColor = 'rgba(255, 0, 0, 0.9)';
    g.shadowBlur = 14;
    g.fillStyle = 'rgba(255, 60, 60, 0.95)';
    g.beginPath(); g.arc(x, y, 5.5 * u, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255, 235, 235, 0.95)';
    g.beginPath(); g.arc(x, y, 2 * u, 0, Math.PI * 2); g.fill();
    g.restore();
    this.keepFading();
  }

  // Traces drawn with the laser: each part fades over LASER_FADE_MS after it was drawn.
  drawTraces(g, a) {
    const now = performance.now();
    this.lasers = this.lasers.filter(tr => now - tr[tr.length - 1][2] < LASER_FADE_MS);
    const all = a?.laser ? [...this.lasers, a.laser] : this.lasers;
    if (!all.length) return;
    const u = 1 / this.s;
    g.save();
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const tr of all) {
      if (tr.length === 1) tr.push(tr[0]); // a tap: a dot
      for (let i = 1; i < tr.length; i++) {
        const k = 1 - (now - tr[i][2]) / LASER_FADE_MS;
        if (k <= 0) continue;
        for (const [w, al] of [[11, 0.22], [3.5, 0.9]]) { // glow, then the core
          g.strokeStyle = `rgba(255, 30, 30, ${al * k})`;
          g.lineWidth = w * u;
          g.beginPath(); g.moveTo(tr[i - 1][0], tr[i - 1][1]); g.lineTo(tr[i][0], tr[i][1]); g.stroke();
        }
      }
    }
    g.restore();
    this.keepFading();
  }
  // redraw on the next frame while something is still fading; stops by itself
  keepFading() {
    if (this.fadeRaf || !(this.lasers.length || this.trail.length > 1)) return;
    this.fadeRaf = requestAnimationFrame(() => { this.fadeRaf = 0; this.requestLive(); });
  }

  // the layer on top: the stroke being written, the lasso, the eraser cursor, the laser pointer
  renderLive() {
    const g = this.lctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.live.width, this.live.height);
    g.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, 0, 0);
    const a = this.active;
    if (a && a.stroke) {
      g.fillStyle = this.colorOf(a.stroke);
      g.fill(strokePath(a.stroke, false));
    }
    if (a && a.lasso && a.lasso.length > 1) {
      g.save();
      g.setLineDash([6, 5]);
      g.strokeStyle = '#ff9800';
      g.lineWidth = 2 / this.s;
      g.beginPath();
      a.lasso.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.stroke();
      g.restore();
    }
    // the pencil at the pen tip while writing (34 x 34 screen px, tip at 2, 32 as in the pointer)
    if (a && a.stroke && this.pencilImg?.complete && this.hover) {
      const u = 1 / this.s;
      g.drawImage(this.pencilImg, this.hover[0] - 2 * u, this.hover[1] - 32 * u, 34 * u, 34 * u);
    }
    this.drawTraces(g, a);
    if (this.tool === 'laser' && !a && this.hover) this.drawLaser(g);
    if (this.hover && (this.tool === 'eraser' || (a && a.eraser) || (!a && this.ctrlHeld && this.tool === 'pen'))) {
      // the eraser: a tinted disc with a white-and-orange rim, visible on white and on the blackboard
      g.save();
      g.beginPath();
      g.arc(this.hover[0], this.hover[1], ERASER_R, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255, 140, 0, 0.25)';
      g.fill();
      g.lineWidth = 3.5 / this.s;
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.stroke();
      g.lineWidth = 1.8 / this.s;
      g.strokeStyle = '#e65100';
      g.stroke();
      g.restore();
    }
  }
}
