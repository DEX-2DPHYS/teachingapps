// HTML panes ("Insert HTML"), shared by the lecturer's whiteboard and the student app.
// A pane is a single-file, self-contained HTML page placed on a page, between the slide and the ink:
//   page.panes = [{ id, src | html, x, y, w, h, zoom, border: 'visible' | 'none', mode: 'own' | 'snapshot', name }]
// zoom: the size of the HTML's content inside the pane (1 = as made; 2 = everything twice as large).
// in page units. src: its web address (Supabase Storage, stored as plain text); html: the text itself
// while it is only on the lecturer's PC. The HTML is put into an iframe with srcdoc, so its content
// type on the server does not matter.
//   Lecturer: sandbox "allow-scripts allow-same-origin" (their own file; needed for snapshots).
//   Students: sandbox "allow-scripts" only: it runs, but cannot reach the app, the login or notes.
// The layer is scaled like the page (layout in page units), so the HTML keeps its layout when zooming.

const CSS = `
.pane-layer { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
.pane-layer iframe { position: absolute; border: 0; background: #fff; pointer-events: none; transform-origin: 0 0; }
.pane-layer.interact iframe { pointer-events: auto; }
.pane-layer iframe.bordered, .pane-layer iframe.peek { outline: 2px solid rgba(31, 95, 209, .55); }
.pane-layer iframe.bordered:not(.peek) { outline-color: rgba(0, 0, 0, .28); }
`;
let cssDone = false;

const okSrc = src => typeof src === 'string' && /^https:\/\//.test(src);
export const newPaneId = () => 'h' + Math.random().toString(36).slice(2, 10);
export const paneZoom = p => Math.max(0.25, Math.min(4, +p.zoom || 1));

// layer: put into `sheet`, before `before` (an element of the sheet) or at its end
export function paneLayer(sheet, { sandbox = 'allow-scripts', before = null } = {}) {
  if (!cssDone) { cssDone = true; const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); }
  const layer = document.createElement('div');
  layer.className = 'pane-layer';
  if (before) sheet.insertBefore(layer, before); else sheet.appendChild(layer);
  const frames = new Map(); // pane id -> { el, key }
  const texts = new Map();  // src -> Promise<html text>

  const textOf = p => {
    if (typeof p.html === 'string') return Promise.resolve(p.html);
    if (!okSrc(p.src)) return Promise.reject(new Error('no address'));
    if (!texts.has(p.src)) texts.set(p.src, fetch(p.src).then(r => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))));
    return texts.get(p.src);
  };

  // panes: the page's panes; s: scale; W, H: page size; opts: { interact, borders (show all) }
  function update(panes, s, W, H, { interact = false, borders = false } = {}) {
    Object.assign(layer.style, { width: W + 'px', height: H + 'px', transform: `scale(${s})` });
    layer.classList.toggle('interact', !!interact);
    const seen = new Set();
    for (const p of panes || []) {
      seen.add(p.id);
      let f = frames.get(p.id);
      const key = p.src || ('local:' + (p.html?.length || 0));
      if (!f || f.key !== key) {
        f?.el.remove();
        const el = document.createElement('iframe');
        el.setAttribute('sandbox', sandbox);
        el.setAttribute('title', p.name || 'HTML');
        el.setAttribute('referrerpolicy', 'no-referrer');
        textOf(p).then(t => { el.srcdoc = t; })
          .catch(() => { el.srcdoc = '<p style="font:14px system-ui,sans-serif;color:#a00;padding:8px">This HTML could not be loaded.</p>'; });
        layer.appendChild(el);
        f = { el, key };
        frames.set(p.id, f);
      }
      // zoom like a browser: lay the HTML out on a smaller (or larger) viewport and scale it up (or down)
      const z = paneZoom(p);
      Object.assign(f.el.style, { left: p.x + 'px', top: p.y + 'px', width: p.w / z + 'px', height: p.h / z + 'px', transform: z === 1 ? '' : `scale(${z})` });
      f.el.classList.toggle('bordered', p.border !== 'none' || borders);
    }
    for (const [id, f] of frames) if (!seen.has(id)) { f.el.remove(); frames.delete(id); }
  }
  // show the border of one pane for a moment (pointer near its top-left corner); null = none
  function peek(id) { for (const [k, f] of frames) f.el.classList.toggle('peek', k === id); }
  return { update, peek, frame: id => frames.get(id)?.el || null, layer };
}

// what students may get: panes they run themselves ("their own copy"), uploaded ones only
export const publicPanes = panes => (panes || [])
  .filter(p => p.mode === 'own' && okSrc(p.src))
  .map(({ id, src, x, y, w, h, zoom, border, name }) => ({ id, src, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), zoom: paneZoom({ zoom }), border: border || 'visible', name: String(name || '').slice(0, 80) }));
