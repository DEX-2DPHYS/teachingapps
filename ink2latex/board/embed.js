// DTUwrite inside an Interactive Presenter deck: a "DTUwrite page" opens this board as
// /?embed=ip&key=<board key>. The board comes from the deck and goes back into the deck file, so
// this mode never reads or writes the board kept in this browser, never sends to students, and keeps
// slides and figures as data (no cloud upload): the .ipe file holds everything.
//
// Messages, only with the page that embeds us (window.parent):
//   DTUwrite → deck  { type: 'dtuwrite-embed-ready', protocol, key, format }     repeated until loaded
//   deck → DTUwrite  { type: 'dtuwrite-embed-load', protocol, key, board | null }
//   DTUwrite → deck  { type: 'dtuwrite-embed-state', protocol, key, board }      ~1.5 s after a change
//   deck → DTUwrite  { type: 'dtuwrite-embed-collect', reqId }                   the deck is being saved
//   DTUwrite → deck  { type: 'dtuwrite-embed-state', protocol, key, reqId, board, snapshots, cur }
//                    (or { ..., reqId, unchanged: true } when there is nothing to give)
//   DTUwrite → deck  { type: 'dtuwrite-embed-slide', protocol, key, dir }        next (1) / previous (-1) slide
// Unknown fields are ignored on both sides, so either app can be updated on its own.
// A board saved by a newer DTUwrite (format above FORMAT) is not opened: the page asks for an update
// and never writes back, so the deck keeps the newer board intact.

export const PROTOCOL = 1;
export const FORMAT = 2; // serialize() writes version 2; restore() reads versions 1 and 2

const params = new URLSearchParams(location.search);
export const EMBED = params.get('embed') === 'ip';
const KEY = params.get('key') || '';

export function initEmbed(app) {
  // app: { serialize(), cur(), PAGE, THEMES, theme(), paintStroke, plainText }
  let loaded = false, blocked = false, resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  const post = msg => window.parent.postMessage({ protocol: PROTOCOL, key: KEY, ...msg }, '*');

  window.addEventListener('message', async e => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'dtuwrite-embed-load' && !loaded) {
      loaded = true;
      const b = d.board || null;
      if (b && Number(b.version || 1) > FORMAT) {
        blocked = true;
        showBlocked();
        resolveReady(null);
        return;
      }
      resolveReady(b);
    } else if (d.type === 'dtuwrite-embed-collect') {
      if (!loaded || blocked) { post({ type: 'dtuwrite-embed-state', reqId: d.reqId, unchanged: true }); return; }
      try {
        const board = await inlineImages(app.serialize());
        const snapshots = await snapshotsOf(board);
        post({ type: 'dtuwrite-embed-state', reqId: d.reqId, board, snapshots, cur: app.cur() });
      } catch (err) {
        post({ type: 'dtuwrite-embed-state', reqId: d.reqId, unchanged: true, error: String(err?.message || err) });
      }
    }
  });

  // Writing on the board gives it the keyboard, so every DTUwrite shortcut works here. The canvas
  // cancels pointerdown (no text selection while writing), which also stops the browser from moving
  // the focus into this frame: the keys then went to the deck.
  document.addEventListener('pointerdown', () => { if (!document.hasFocus()) window.focus(); }, true);

  // say hello until the deck answers (its side may still be setting up); give up after 30 s
  let tries = 0;
  (function hello() {
    if (loaded || tries++ > 60) return;
    post({ type: 'dtuwrite-embed-ready', format: FORMAT });
    setTimeout(hello, 500);
  })();

  function showBlocked() {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(250,250,248,.96);color:#222;font:18px/1.5 system-ui,"Segoe UI",sans-serif;text-align:center;padding:24px';
    d.innerHTML = '<div style="max-width:520px"><b>This board was saved by a newer DTUwrite.</b><br>' +
      'Update DTUwrite on this PC to open it here. The presentation keeps the board unchanged.</div>';
    document.body.appendChild(d);
  }

  // Slides or figures that live in the cloud (a board signed in under 📡 Send) are copied into the
  // board as data, so the deck does not depend on the cloud copy.
  const inlined = new Map();
  async function inlineImages(board) {
    for (const p of board.pages || []) {
      for (const im of p.images || []) {
        if (!/^https?:/i.test(im.src || '')) continue;
        if (!inlined.has(im.src)) {
          inlined.set(im.src, fetch(im.src).then(r => (r.ok ? r.blob() : null)).then(b => (b ? blobToDataUrl(b) : null)).catch(() => null));
        }
        const data = await inlined.get(im.src);
        if (data) im.src = data;
      }
    }
    return board;
  }

  // One picture per page (slides and figures, ink, typed text), shown by the deck when DTUwrite is
  // not running on that PC. Answers and typeset results are not drawn: it is a fallback view.
  async function snapshotsOf(board) {
    const [W, H] = app.PAGE[board.orientation] || app.PAGE.portrait;
    const k = Math.min(1, 1600 / W);
    const theme = app.THEMES[app.theme()] || app.THEMES.white;
    const out = [];
    for (const p of (board.pages || []).slice(0, 60)) {
      const c = document.createElement('canvas');
      c.width = Math.round(W * k); c.height = Math.round(H * k);
      const g = c.getContext('2d');
      g.fillStyle = theme.bg; g.fillRect(0, 0, c.width, c.height);
      g.setTransform(k, 0, 0, k, 0, 0);
      const ims = [...(p.images || [])].sort((a, b) => (b.bg ? 1 : 0) - (a.bg ? 1 : 0));
      for (const im of ims) {
        const img = await loadImage(im.src);
        if (img) g.drawImage(img, im.x, im.y, im.w, im.h);
      }
      for (const s of p.strokes || []) app.paintStroke(g, { ...s, _path: null }, theme.palette[s.color] || s.color || theme.palette.auto);
      for (const t of p.texts || []) {
        const size = Number(t.size) || 32;
        g.fillStyle = theme.palette[t.color] || t.color || theme.palette.auto;
        g.font = `${size}px ${t.font === 'serif' ? 'Georgia, serif' : 'system-ui, "Segoe UI", sans-serif'}`;
        String(app.plainText(t.html || '') || '').split('\n').forEach((line, i) => g.fillText(line, t.x, t.y + size * (1 + i * 1.25)));
      }
      const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.82));
      out.push(blob ? await blobToDataUrl(blob) : c.toDataURL('image/png'));
    }
    return out;
  }

  return {
    ready, // resolves with the deck's board, or null for a new board (or one that may not be opened)
    blocked: () => blocked,
    changed(board) { if (loaded && !blocked) post({ type: 'dtuwrite-embed-state', board }); },
    // next / previous past the board's last / first page: the deck's next / previous slide (a clicker
    // keeps working through the presentation while the board has the keyboard)
    slide(dir) { post({ type: 'dtuwrite-embed-slide', dir: dir < 0 ? -1 : 1 }); },
  };
}

function loadImage(src) {
  return new Promise(res => {
    if (!src) return res(null);
    const img = new Image();
    const t = setTimeout(() => res(null), 8000);
    img.onload = () => { clearTimeout(t); res(img); };
    img.onerror = () => { clearTimeout(t); res(null); };
    img.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
