// Full screen mode, shared by the whiteboard (lecturer and students) and the student app.
// The page fills the screen (and the browser goes full screen where it allows); the app's toolbar
// slides away and comes back when the pointer reaches the top edge, or with the ▾ tab at the top
// (tablets have no hover). A minimal floating bar at the left holds the essential tools as symbols,
// with a tooltip after the pointer rests on one for 1 s. Exit: ⛶ in the floating bar, or Esc.
// persistent: the same bar is also shown outside full screen (the whiteboard's tool bar), with an
// optional ✕ (onClose) and text entries such as the page counter ({ label: () => '2/4', tip }).

const CSS = `
body.fs .fs-hide { display: none !important; }
body.fs .fs-toolbar { position: fixed !important; left: 0; right: 0; top: 0; z-index: 300; transform: translateY(-105%);
  transition: transform .2s ease; box-shadow: 0 4px 18px rgba(0,0,0,.25); }
body.fs.fs-reveal .fs-toolbar { transform: none; }
#fsBar { display: none; position: fixed; left: 8px; top: 50%; transform: translateY(-50%); z-index: 250; flex-direction: column; gap: 4px;
  padding: 6px; border-radius: 12px; background: var(--panel, #fff); border: 1px solid var(--line, #ddd); box-shadow: 0 4px 18px rgba(0,0,0,.22);
  -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
body.fs #fsBar, body.fs-tools #fsBar { display: flex; }
#fsBar .fs-label { font: 600 11px/1.2 system-ui, sans-serif; color: var(--dim, #777); text-align: center; padding: 2px 0; font-variant-numeric: tabular-nums; }
#fsBar button.fs-close { height: 24px; font-size: 12px; color: var(--dim, #777); }
#fsBar button { width: 40px; height: 40px; padding: 0; border-radius: 9px; border: 1px solid transparent; background: transparent;
  color: var(--text, #222); font: 18px/1 system-ui, sans-serif; cursor: pointer; display: flex; align-items: center; justify-content: center; }
#fsBar button:hover { background: var(--btn-hover, #ececea); }
#fsBar button:focus:not(:focus-visible) { outline: none; }
#fsBar button.on { background: var(--accent, #1f5fd1); color: #fff; }
#fsBar hr { border: 0; border-top: 1px solid var(--line, #ddd); margin: 2px 4px; }
#fsTab { display: none; position: fixed; top: 0; left: 50%; transform: translateX(-50%); z-index: 260; width: 64px; height: 22px; padding: 0;
  border: 1px solid var(--line, #ccc); border-top: 0; border-radius: 0 0 12px 12px; background: var(--panel, #fff); color: var(--text, #333);
  opacity: .75; font: 13px/1 system-ui, sans-serif; cursor: pointer; }
body.fs #fsTab { display: block; }
body.fs.fs-reveal #fsTab { display: none; }
#fsTip { position: fixed; z-index: 400; pointer-events: none; padding: 4px 9px; border-radius: 6px; background: #222; color: #fff;
  font: 12px/1.3 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
#fsTip[hidden] { display: none; }
`;

// toolbar: the app's toolbar element; hide: elements hidden in full screen (side panel …);
// tools: [{ icon, tip, run(), on?() }] (null = a separator); menuOpen(): a toolbar menu is open
export function initFullscreen({ toolbar, hide = [], tools = [], menuOpen = () => false, onChange, persistent = false, onClose = null }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
  toolbar.classList.add('fs-toolbar');
  hide.forEach(el => el?.classList.add('fs-hide'));

  const bar = document.createElement('div');
  bar.id = 'fsBar';
  let on = false, hideTimer = 0, tipTimer = 0;
  const fsTool = { icon: '⛶', tip: () => (on ? 'Leave full screen (Esc)' : 'Full screen (Esc leaves)'), run: () => (on ? exit() : enter()) };
  const all = [...tools, null, fsTool];
  if (onClose) all.push({ icon: '✕', tip: 'Hide the tool bar (View → Tool bar brings it back; the keys still work)', run: () => onClose(), close: true });
  const labels = [];
  all.forEach((t, i) => {
    if (!t) { bar.appendChild(document.createElement('hr')); return; }
    if (t.label) {
      const sp = document.createElement('div');
      sp.className = 'fs-label'; sp.title = t.tip || ''; sp.textContent = t.label();
      labels.push([sp, t]); bar.appendChild(sp); return;
    }
    const b = document.createElement('button');
    if (t.close) b.className = 'fs-close';
    b.textContent = t.icon;
    b.dataset.i = i;
    b.setAttribute('aria-label', typeof t.tip === 'function' ? t.tip() : t.tip);
    b.addEventListener('click', () => { hideTip(); t.run(); sync(); b.blur(); }); // no focus frame left on it
    bar.appendChild(b);
  });
  const tab = document.createElement('button');
  tab.id = 'fsTab'; tab.textContent = '▾'; tab.title = 'Show the menu';
  const tip = document.createElement('div');
  tip.id = 'fsTip'; tip.hidden = true;
  document.body.append(bar, tab, tip);

  const native = () => document.fullscreenElement || document.webkitFullscreenElement;
  function enter() {
    if (on) return;
    on = true;
    document.body.classList.add('fs');
    const d = document.documentElement, req = d.requestFullscreen || d.webkitRequestFullscreen;
    try { const p = req?.call(d); p?.catch?.(() => {}); } catch { /* not allowed: the app's own full screen still works */ }
    sync();
    onChange?.(true);
  }
  function exit() {
    if (!on) return;
    on = false;
    document.body.classList.remove('fs', 'fs-reveal');
    hideTip();
    if (native()) { const ex = document.exitFullscreen || document.webkitExitFullscreen; try { const p = ex?.call(document); p?.catch?.(() => {}); } catch { /* ignore */ } }
    onChange?.(false);
  }
  // the browser's own Esc (or swipe) leaves its full screen: leave ours too
  for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { if (on && !native()) exit(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && on && !native() && !e.target.isContentEditable && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) exit();
  });

  // the toolbar: down at the top edge (or with the tab), away again once the pointer is back on the page
  const reveal = r => { clearTimeout(hideTimer); document.body.classList.toggle('fs-reveal', r); };
  tab.addEventListener('click', () => reveal(true));
  document.addEventListener('pointermove', e => {
    if (!on || e.pointerType === 'touch') return;
    if (e.clientY < 8) { reveal(true); return; }
    if (document.body.classList.contains('fs-reveal') && e.clientY > toolbar.offsetHeight + 50 && !menuOpen()) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!menuOpen()) reveal(false); }, 700);
    }
  });
  // tablets: a touch on the page closes the revealed toolbar (unless a menu of it is open)
  document.addEventListener('pointerdown', e => {
    if (on && document.body.classList.contains('fs-reveal') && !toolbar.contains(e.target) && !e.target.closest('.popup, #settingsMenu, #sendMenu, #viewMenu, #figMenu') && !menuOpen()) reveal(false);
  }, true);

  // tooltips after resting 1 s on a symbol (mouse or hovering pen)
  function hideTip() { clearTimeout(tipTimer); tip.hidden = true; }
  bar.addEventListener('pointerover', e => {
    const b = e.target.closest('button');
    if (!b || e.pointerType === 'touch') return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const r = b.getBoundingClientRect();
      const tt = all[+b.dataset.i].tip;
      tip.textContent = typeof tt === 'function' ? tt() : tt;
      tip.hidden = false;
      tip.style.left = r.right + 8 + 'px';
      tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
    }, 1000);
  });
  bar.addEventListener('pointerout', hideTip);
  bar.addEventListener('pointerdown', hideTip);

  // which tool is on
  function sync() {
    bar.querySelectorAll('button').forEach(b => { const t = all[+b.dataset.i]; b.classList.toggle('on', !!t?.on?.()); });
    for (const [sp, t] of labels) sp.textContent = t.label();
  }
  const setPersistent = v => { document.body.classList.toggle('fs-tools', !!v); sync(); };
  setPersistent(persistent);
  return { enter, exit, toggle: () => (on ? exit() : enter()), sync, active: () => on, setPersistent };
}
