// Send mode (lecturer side): publishes the pages of this session to Supabase while "live" is on,
// so students can follow in the viewer (../viewer/). Only the lecturer app has AI keys; students
// only read. The lecturer signs in with a normal Supabase account (email + password).

import { SUPABASE_URL, SUPABASE_KEY, SCHEMA, VIEWER_URL, LIBS } from '../config.js?v=2026-10-06.0559';

const SEND_DELAY = 1500; // ms after the last change
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

let sb = null;
async function client() {
  if (!sb) {
    const { createClient } = await import(LIBS.supabase);
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      db: { schema: SCHEMA },
      auth: { storageKey: 'ink2latex-lecturer', persistSession: true, autoRefreshToken: true },
    });
  }
  return sb;
}

// quick string hash to see whether a page changed since it was last sent
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + str.length;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function initSend(app) {
  // app: { state, settings, saveSettings, pagePayload(page), orientation(), toast(msg) }
  const $ = s => document.querySelector(s);
  const btn = $('#sendBtn'), menu = $('#sendMenu');
  const S = {
    user: null,
    lecture: app.settings.sendLecture || null, // {id, title, course_code, join_code}
    live: false,
    busy: false,
    error: '',
    lastSent: null,
    sent: new Map(),   // page uid -> hash of what was last sent
    order: '',         // page uids joined, as last sent
    curPage: -1,
    versions: new Map(),
    view: 'main',      // 'main' | 'new' | 'pick'
    lectures: [],
  };
  let timer = 0;

  const viewerUrl = () => {
    const base = VIEWER_URL || `${location.origin}/viewer/`;
    return S.lecture ? `${base}${base.includes('?') ? '&' : '?'}c=${S.lecture.join_code}` : base;
  };

  function renderBtn() {
    btn.classList.toggle('live', S.live);
    btn.innerHTML = S.live
      ? `<span class="live-dot"></span> LIVE ${esc(S.lecture?.join_code || '')}`
      : '📡 Send';
    btn.title = S.live ? `Sending to students. Last sent ${S.lastSent ? S.lastSent.toLocaleTimeString() : '-'}` : 'Send this lecture live to students';
  }

  async function render() {
    renderBtn();
    if (menu.hidden) return;
    if (!S.user) {
      menu.innerHTML = `
        <strong>Send to students</strong>
        <p class="dim small">Sign in with your lecturer account (the TeachingApps Supabase project).</p>
        <input id="sendEmail" type="email" placeholder="email" autocomplete="username">
        <input id="sendPass" type="password" placeholder="password" autocomplete="current-password">
        <div class="actions"><button data-s="login">Sign in</button></div>
        ${S.error ? `<div class="error-msg">${esc(S.error)}</div>` : ''}`;
      return;
    }
    if (S.view === 'new') {
      menu.innerHTML = `
        <strong>New lecture</strong>
        <input id="sendCourse" placeholder="course, e.g. 10855-2026" value="${esc(app.settings.sendCourse || '')}">
        <input id="sendTitle" placeholder="title, e.g. Lecture 5: Rutherford scattering">
        <div class="actions"><button data-s="create">Create</button><button data-s="back">Cancel</button></div>
        ${S.error ? `<div class="error-msg">${esc(S.error)}</div>` : ''}`;
      return;
    }
    if (S.view === 'pick') {
      const onBoard = app.settings.boardLecture || null;
      const day = iso => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
      menu.innerHTML = `
        <strong>My lectures</strong>
        <p class="dim small">Each lecture has its own board: opening one saves the board you leave and brings back that lecture's board, still editable.</p>
        <div class="lec-list">${S.lectures.map(l => `<button data-pick="${l.id}" class="${l.id === onBoard ? 'on-board' : ''}">${esc(l.course_code)} · ${esc(l.title)} <span class="dim">${esc(l.join_code)} · ${day(l.created_at)}${l.id === onBoard ? ' · on the board' : ''}</span></button>`).join('') || '<p class="dim">None yet.</p>'}
          <button data-pick="local" class="${!onBoard ? 'on-board' : ''}">Local board <span class="dim">not tied to a lecture${!onBoard ? ' · on the board' : ''}</span></button></div>
        <div class="actions"><button data-s="back">Back</button></div>`;
      return;
    }
    const L = S.lecture;
    menu.innerHTML = `
      <div class="row-between"><strong>Send to students</strong><span class="dim small">${esc(S.user.email)} · <a href="#" data-s="logout">sign out</a></span></div>
      ${L ? `
        <div class="lec-title">${esc(L.course_code)} · ${esc(L.title)}</div>
        <div class="join">Join code <span class="code">${esc(L.join_code)}</span></div>
        <div class="dim small">Students open <a href="${esc(viewerUrl())}" target="_blank">${esc(viewerUrl())}</a></div>
        <div class="actions">
          <button data-s="live" class="${S.live ? 'stop' : 'go'}">${S.live ? '■ Stop sending' : '● Start sending'}</button>
          <button data-s="show">Show code on board</button>
        </div>
        <div class="dim small">${S.live ? `Live: every change is sent ~${SEND_DELAY / 1000} s after you stop writing.${S.lastSent ? ` Last sent ${S.lastSent.toLocaleTimeString()}.` : ''}` : 'Not sending. Students see the state of the last send.'}</div>
        ${VIEWER_URL ? '' : '<div class="warn small">The viewer is not hosted yet: this link only works on this PC. Set VIEWER_URL in viewer/config.js once it is on GitHub Pages.</div>'}
      ` : '<p class="dim">No lecture chosen yet.</p>'}
      <div class="actions"><button data-s="new">New lecture…</button><button data-s="pick">My lectures…</button>${L ? '<button data-s="review" title="All comments, questions and your replies for this lecture, also hidden ones; download">💬 Questions &amp; comments</button>' : ''}</div>
      ${S.error ? `<div class="error-msg">${esc(S.error)}</div>` : ''}`;
  }

  async function refreshUser() {
    const c = await client();
    const { data } = await c.auth.getSession();
    const u = data.session?.user;
    S.user = u && !u.is_anonymous ? u : null;
  }

  // ---- actions
  async function login() {
    S.error = '';
    const c = await client();
    const { data, error } = await c.auth.signInWithPassword({ email: $('#sendEmail').value.trim(), password: $('#sendPass').value });
    if (error) { S.error = error.message; render(); return; }
    S.user = data.user;
    app.onLogin?.();
    render();
  }

  async function logout() {
    stopLive();
    const c = await client();
    await c.auth.signOut();
    S.user = null;
    render();
  }

  function newCode() {
    const a = new Uint32Array(6);
    crypto.getRandomValues(a);
    return [...a].map(v => CODE_CHARS[v % CODE_CHARS.length]).join('');
  }

  async function create() {
    S.error = '';
    const course = $('#sendCourse').value.trim(), title = $('#sendTitle').value.trim();
    if (!course || !title) { S.error = 'Course and title are needed.'; render(); return; }
    const c = await client();
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = { course_code: course, title, join_code: newCode() };
      const { data, error } = await c.from('lectures').insert(row).select('id, title, course_code, join_code').single();
      if (!error) {
        app.settings.sendCourse = course;
        await chooseLecture(data, { isNew: true });
        S.view = 'main';
        render();
        return;
      }
      if (!/duplicate|unique/i.test(error.message)) { S.error = error.message; render(); return; }
    }
    S.error = 'Could not find a free join code, try again.';
    render();
  }

  async function pick() {
    const c = await client();
    const { data, error } = await c.from('lectures').select('id, title, course_code, join_code, created_at')
      .eq('owner', S.user.id).order('created_at', { ascending: false }).limit(30);
    S.lectures = error ? [] : data;
    S.error = error ? error.message : '';
    S.view = 'pick';
    render();
  }

  // Choosing a lecture also opens its board (one board per lecture, see switchBoard in app.js). A new
  // lecture takes over the board on screen if that is the local one (not tied to a lecture yet).
  // l = null: back to the local board.
  async function chooseLecture(l, { isNew = false } = {}) {
    stopLive();
    await backupNow(); // the board being left, to the cloud
    S.lecture = l ? { id: l.id, title: l.title, course_code: l.course_code, join_code: l.join_code } : null;
    app.settings.sendLecture = S.lecture;
    app.saveSettings();
    S.sent.clear(); S.order = ''; S.curPage = -1; S.versions.clear();
    const keep = isNew && !app.settings.boardLecture;
    if (await app.switchBoard(l?.id || null, { keep, fetchCloud: cloudBoard })) {
      app.toast?.(l ? `Board of "${l.title}"` : 'Local board (not tied to a lecture)');
    }
  }

  // ---- cloud copy of the board (table ink2latex.boards, only the lecturer can read it): the whole
  // board, saved ~30 s after changes while a lecture is chosen and you are signed in
  let backupTimer = 0;
  const isLectureId = id => /^[0-9a-f-]{36}$/i.test(id || ''); // not an assignment / review board
  function backupSoon() {
    if (!S.user || !isLectureId(app.settings.boardLecture)) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(backupNow, 30000);
  }
  async function backupNow() {
    clearTimeout(backupTimer);
    const id = app.settings.boardLecture;
    if (!S.user || !isLectureId(id)) return;
    try {
      const c = await client();
      const { error } = await c.from('boards').upsert({ lecture_id: id, data: app.boardData(), updated_at: new Date().toISOString() }, { onConflict: 'lecture_id' });
      if (error) console.warn('board backup:', error.message);
    } catch (err) { console.warn('board backup:', err); }
  }
  // the cloud copy of a lecture's board; or else rebuilt from the pages sent to the students
  async function cloudBoard(id) {
    if (!S.user) return null;
    const c = await client();
    const { data } = await c.from('boards').select('data').eq('lecture_id', id).maybeSingle();
    if (data?.data) return data.data;
    const { data: rows } = await c.from('lecture_pages').select('page_no, orientation, strokes, blocks, updated_at').eq('lecture_id', id).order('page_no');
    return app.fromSentPages(rows);
  }
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') backupNow(); });

  function startLive() {
    if (!S.lecture) return;
    // sending replaces the lecture's pages: only ever from that lecture's own board
    if (app.settings.boardLecture !== S.lecture.id) {
      S.error = 'The board on screen belongs to another lecture. Choose this lecture again under "My lectures…" to open its board.';
      render();
      return;
    }
    S.live = true;
    S.sent.clear(); S.order = ''; S.curPage = -1; // first send: everything
    push();
  }
  function stopLive() {
    S.live = false; clearTimeout(timer); renderBtn();
    if (app.settings.sendLiveAt) { delete app.settings.sendLiveAt; app.saveSettings(); } // stopped on purpose
  }

  // ---- sending
  function changed() {
    // the students' circles belong to one page: redraw them after a page switch
    if (dotsLayer && +dotsLayer.dataset.page !== app.state.cur) renderDots();
    backupSoon();
    if (!S.live) return;
    clearTimeout(timer);
    timer = setTimeout(push, SEND_DELAY);
  }

  async function push() {
    if (!S.live || !S.lecture) return;
    if (app.settings.boardLecture !== S.lecture.id) return; // another board on screen (a hand-in): paused
    if (S.busy) { changed(); return; }
    S.busy = true;
    try {
      await app.uploadPending?.(); // slides/figures still only on this PC
      const c = await client();
      for (const p of app.state.pages) if (!p.uid) p.uid = crypto.randomUUID();
      const pages = app.state.pages.filter(p => !p.hidden); // hidden pages are not sent
      const order = pages.map(p => p.uid).join(',');
      const full = order !== S.order; // pages added, removed or reordered: resend all
      const rows = [];
      pages.forEach((p, i) => {
        const payload = app.pagePayload(p);
        const h = hash(JSON.stringify(payload));
        if (!full && S.sent.get(p.uid) === h) return;
        const version = (S.versions.get(i) || 0) + 1;
        rows.push({ row: { lecture_id: S.lecture.id, page_no: i, version, orientation: app.orientation(), ...payload, updated_at: new Date().toISOString() }, uid: p.uid, h, i, version });
      });
      for (const r of rows) {
        let { error } = await c.from('lecture_pages').upsert(r.row, { onConflict: 'lecture_id,page_no' });
        if (error && /texts|images|panes/.test(error.message)) {
          // the database has no text-box / image column yet (supabase-setup.sql not re-run): send without
          const { texts, images, panes, ...rest } = r.row;
          ({ error } = await c.from('lecture_pages').upsert(rest, { onConflict: 'lecture_id,page_no' }));
          if (!error && texts?.length && !S.warnedTexts) { S.warnedTexts = true; app.toast('Text boxes are not sent yet: run supabase-setup.sql once more'); }
        }
        if (error) throw error;
        S.sent.set(r.uid, r.h);
        S.versions.set(r.i, r.version);
      }
      if (full) {
        const { error } = await c.from('lecture_pages').delete().eq('lecture_id', S.lecture.id).gte('page_no', pages.length);
        if (error) throw error;
        S.order = order;
      }
      const curSent = app.sentIndex(app.state.cur); // on a hidden page: students stay on the page before
      if (S.curPage !== curSent) {
        const { error } = await c.from('lectures').update({ current_page: curSent }).eq('id', S.lecture.id);
        if (error) throw error;
        S.curPage = curSent;
      }
      S.lastSent = new Date();
      // remembered, so a reload of the board resumes sending (see the start of initSend's last lines)
      if (Date.now() - (app.settings.sendLiveAt || 0) > 60000) { app.settings.sendLiveAt = Date.now(); app.saveSettings(); }
      S.error = '';
    } catch (err) {
      S.error = 'Sending failed: ' + (err.message || err);
      app.toast(S.error);
      changed(); // try again after the next pause
    } finally {
      S.busy = false;
      render();
    }
  }

  async function qrSvg(text) {
    const mod = await import(LIBS.qrcode);
    const qrcode = mod.default || mod;
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  }

  async function showCode() {
    if (!S.lecture) return;
    const ov = document.createElement('div');
    ov.id = 'joinOverlay';
    ov.innerHTML = `<div class="join-box">
      <div class="dim">Follow this lecture</div>
      <div class="big-code">${esc(S.lecture.join_code)}</div>
      <div class="qr">${await qrSvg(viewerUrl())}</div>
      <div class="dim small">${esc(viewerUrl())}</div>
      <div class="dim small">click to close</div></div>`;
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  }

  // ---- wiring
  btn.addEventListener('click', async e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      menu.innerHTML = '<span class="dim">connecting…</span>';
      try { await refreshUser(); } catch (err) { S.error = 'Supabase not reachable: ' + err.message; }
      render();
    }
  });
  menu.addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'sendPass') login(); });
  menu.addEventListener('click', e => {
    const t = e.target.closest('[data-s], [data-pick]');
    if (!t) return;
    e.preventDefault();
    const a = t.dataset.s;
    if (t.dataset.pick) {
      const l = t.dataset.pick === 'local' ? null : S.lectures.find(x => x.id === t.dataset.pick);
      S.view = 'main'; S.error = '';
      Promise.resolve(chooseLecture(l)).then(render);
      return;
    }
    if (a === 'review') { menu.hidden = true; openQWin(); }
    if (a === 'login') login();
    if (a === 'logout') logout();
    if (a === 'new') { S.view = 'new'; S.error = ''; render(); }
    if (a === 'pick') pick();
    if (a === 'back') { S.view = 'main'; S.error = ''; render(); }
    if (a === 'create') create();
    if (a === 'live') { S.live ? stopLive() : startLive(); render(); }
    if (a === 'show') { menu.hidden = true; showCode(); } // the menu would stay open behind the code
  });
  window.addEventListener('beforeunload', e => { if (S.live && S.busy) e.preventDefault(); });

  // ---- student questions and comments (viewer: double-click on the page, or "Q: ..." / "C: ...").
  // A small red circle bottom left with the number of open ones opens a list window. Placed ones also
  // appear on the board where the student put them: red = question, green = comment (View menu:
  // "Student comments & questions"). A new one pops up with a short bump.
  let qTimer = 0, qChannel = null, questions = [], seen = null, expanded = null;
  const qBtn = document.createElement('button');
  qBtn.id = 'qBadge';
  qBtn.title = 'Questions and comments from students';
  qBtn.hidden = true;
  document.body.appendChild(qBtn);
  const kindOf = q => (q.kind === 'comment' ? 'comment' : 'question');
  const isOpen = q => q.status === 'open';

  async function loadQuestions() {
    if (!S.user || !S.lecture) return;
    const c = await client();
    const q = cols => c.from('questions').select(cols).eq('lecture_id', S.lecture.id).order('created_at'); // hidden ones too (review)
    let { data, error } = await q('id, page_no, text, kind, status, x, y, answer, created_at');
    if (error) ({ data, error } = await q('id, page_no, text, status, created_at')); // setup not re-run yet: no kind, x, y, answer
    if (error) { console.warn('questions:', error.message); return; } // e.g. the questions table has not been set up yet
    const fresh = seen ? data.filter(x => !seen.has(x.id)) : []; // nothing counts as new on the first load
    seen = new Set(data.map(x => x.id));
    questions = data;
    const open = questions.filter(isOpen).length;
    qBtn.textContent = open;
    qBtn.hidden = open === 0 && !$('#qWin');
    if (fresh.length) {
      qBtn.classList.remove('bump'); void qBtn.offsetWidth; qBtn.classList.add('bump');
      const x = fresh[fresh.length - 1];
      if (x.page_no !== app.state.cur || x.x == null || app.settings.showStudent === false) {
        app.toast?.(`New ${kindOf(x)} from a student (page ${x.page_no + 1}): ${x.text.slice(0, 80)}`);
      }
    }
    renderQWin();
    renderDots(new Set(fresh.map(x => x.id)));
  }

  function watchQuestions() {
    clearInterval(qTimer);
    qChannel?.unsubscribe();
    qChannel = null;
    questions = []; seen = null;
    renderDots();
    if (!S.user || !S.lecture) { qBtn.hidden = true; return; }
    loadQuestions();
    qTimer = setInterval(loadQuestions, 15000); // safety net next to the live channel
    client().then(c => {
      qChannel = c.channel('questions-' + S.lecture.id)
        .on('postgres_changes', { event: '*', schema: SCHEMA, table: 'questions', filter: `lecture_id=eq.${S.lecture.id}` }, () => loadQuestions())
        .subscribe();
    });
  }

  function renderQWin() {
    const w = $('#qWin');
    if (!w) return;
    const t = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    keepDrafts(() => {
      const list = showHidden ? questions : questions.filter(q => q.status !== 'hidden');
      w.querySelector('.q-count').textContent = `${questions.length} in this lecture${questions.length - list.length ? `, ${questions.length - list.length} hidden` : ''}`;
      w.querySelector('.q-list').innerHTML = list.length ? list.map(q => `
        <div class="q-item k-${kindOf(q)} st-${q.status}">
          <div class="q-meta">${kindOf(q) === 'comment' ? '💬 comment' : '❓ question'} · page ${q.page_no + 1} · ${t(q.created_at)}${q.status === 'answered' ? ' · done' : q.status === 'hidden' ? ' · hidden' : ''}</div>
          <div class="q-text">${esc(q.text)}</div>
          ${replyBox(q)}
          <div class="q-act">${actions(q, true)}</div>
        </div>`).join('') : '<p class="dim">No questions or comments.</p>';
    });
  }
  const actions = (q, withShow) => (withShow && q.x != null ? `<button data-qa="show" data-id="${q.id}" title="Go to the page and show where the student placed it">📍 Show</button>` : '')
    + (isOpen(q) ? `<button data-qa="answered" data-id="${q.id}">${kindOf(q) === 'comment' ? '✓ Seen' : '✓ Answered'}</button>` : '')
    + (q.status === 'hidden' ? `<button data-qa="${q.answer ? 'answered' : 'open'}" data-id="${q.id}">Show again</button>`
      : `<button data-qa="hidden" data-id="${q.id}" title="Take it off the board and out of the list (it is kept: 'show hidden')">Hide</button>`);

  // a written reply, e.g. for a question asked outside the lecture; the student sees it under their question
  const drafts = new Map(); // question id -> reply being typed (survives the live updates)
  const replyBox = q => `<div class="q-reply">
      ${q.answer ? `<div class="q-answer"><b>Your reply:</b> ${esc(q.answer)}</div>` : ''}
      <textarea data-reply="${q.id}" rows="2" maxlength="2000" placeholder="${q.answer ? 'Change your reply…' : 'Write a reply (the student sees it)…'}"></textarea>
      <button data-qa="reply" data-id="${q.id}">Send reply</button>
    </div>`;
  document.addEventListener('input', e => { const id = e.target.dataset?.reply; if (id) drafts.set(id, e.target.value); });
  // re-render without losing what is being typed, or the place of the cursor
  function keepDrafts(render) {
    const a = document.activeElement, id = a?.dataset?.reply, inWin = a?.closest?.('#qWin') ? '#qWin' : '#studentDots', pos = a?.selectionStart;
    render();
    for (const el of document.querySelectorAll('[data-reply]')) if (drafts.has(el.dataset.reply)) el.value = drafts.get(el.dataset.reply);
    if (id) { const el = document.querySelector(`${inWin} [data-reply="${id}"]`); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
  }

  // circles on the board, for the page on screen
  let dotsLayer = null;
  function renderDots(bump = new Set()) {
    const sheet = app.board.sheet;
    if (!dotsLayer) {
      dotsLayer = document.createElement('div');
      dotsLayer.id = 'studentDots';
      sheet.appendChild(dotsLayer);
      new ResizeObserver(() => renderDots()).observe(sheet); // zoom, window size, page format
      dotsLayer.addEventListener('pointerdown', e => e.stopPropagation());
      dotsLayer.addEventListener('click', e => {
        const a = e.target.closest('[data-qa]');
        if (a) { act(a.dataset.qa, a.dataset.id); return; }
        const d = e.target.closest('.s-dot');
        if (!d || e.target.closest('.s-dot-text')) return; // clicks inside the open bubble keep it open
        expanded = expanded === d.dataset.id ? null : d.dataset.id;
        renderDots();
      });
    }
    dotsLayer.dataset.page = app.state.cur;
    const s = app.board.s;
    const list = app.settings.showStudent === false ? []
      : questions.filter(q => q.x != null && q.y != null && !app.state.pages[app.state.cur]?.hidden && q.page_no === app.sentIndex(app.state.cur) && q.status !== 'hidden');
    keepDrafts(() => {
      dotsLayer.innerHTML = list.map(q => `
        <div class="s-dot k-${kindOf(q)} st-${q.status}${q.x > app.board.pageW / 2 ? ' flip' : ''}${q.id === expanded ? ' expanded' : ''}${bump.has(q.id) ? ' bump' : ''}" data-id="${q.id}" style="left:${q.x * s}px;top:${q.y * s}px">
          <button class="s-dot-c" title="${esc(q.text)}">${kindOf(q) === 'comment' ? '💬' : '?'}</button>
          <div class="s-dot-text"><div class="q-text">${esc(q.text)}</div>${replyBox(q)}<div class="q-act">${actions(q, false)}</div></div>
        </div>`).join('');
    });
  }

  async function act(what, id) {
    const q = questions.find(x => x.id === id);
    if (!q) return;
    if (what === 'show') {
      const real = app.realIndex(q.page_no); // students' page number -> this board's page
      if (real < 0) { app.toast?.('That page no longer exists on the board.'); return; }
      if (app.settings.showStudent === false) { app.settings.showStudent = true; app.saveSettings(); const cb = $('#showStudent'); if (cb) cb.checked = true; }
      expanded = q.id;
      app.gotoPage(real);
      renderDots();
      dotsLayer.querySelector(`[data-id="${q.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const c = await client();
    if (what === 'reply') {
      const text = (drafts.get(id) || '').trim();
      if (!text) { app.toast?.('Write the reply first.'); return; }
      const { error } = await c.from('questions').update({ answer: text, answered_at: new Date().toISOString(), status: 'answered' }).eq('id', id);
      if (error) { app.toast?.('Reply not saved: ' + error.message + (/column/i.test(error.message) ? ' (re-run supabase-setup.sql)' : '')); return; }
      drafts.delete(id);
      app.toast?.('Reply sent to the student');
    } else {
      await c.from('questions').update({ status: what }).eq('id', id);
    }
    loadQuestions();
  }
  // Ctrl+Enter in a reply field sends it
  document.addEventListener('keydown', e => {
    const id = e.target.dataset?.reply;
    if (id && e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); act('reply', id); }
  });

  let showHidden = false;
  qBtn.addEventListener('click', e => {
    e.stopPropagation();
    if ($('#qWin')) { $('#qWin').remove(); qBtn.hidden = !questions.some(isOpen); return; }
    openQWin();
  });
  function openQWin() {
    if ($('#qWin')) return;
    if (!S.lecture) { app.toast?.('Choose a lecture first (📡 Send → My lectures).'); return; }
    qBtn.hidden = false;
    const w = document.createElement('div');
    w.id = 'qWin';
    w.innerHTML = `<div class="q-head"><strong>From the students</strong><button data-qa="close" title="Close">✕</button></div>
      <div class="q-tools"><span class="q-count dim"></span><label><input type="checkbox" id="qShowHidden" ${showHidden ? 'checked' : ''}> show hidden</label><button data-qa="download" title="All comments, questions and replies of this lecture as a text file">⬇ Download</button></div>
      <div class="q-list"></div>`;
    w.addEventListener('pointerdown', e => e.stopPropagation());
    w.querySelector('#qShowHidden').addEventListener('change', e => { showHidden = e.target.checked; renderQWin(); });
    document.body.appendChild(w);
    renderQWin();
    w.addEventListener('click', ev => {
      const b = ev.target.closest('[data-qa]');
      if (!b) return;
      if (b.dataset.qa === 'close') { w.remove(); qBtn.hidden = !questions.some(isOpen); return; }
      if (b.dataset.qa === 'download') { download(); return; }
      act(b.dataset.qa, b.dataset.id);
    });
  }

  // everything of this lecture as Markdown: per page, with time, kind, status and your reply
  function download() {
    const L = S.lecture;
    const t = iso => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    const pages = [...new Set(questions.map(q => q.page_no))].sort((a, b) => a - b);
    const md = [`# ${L.course_code} · ${L.title}`, '', `Comments and questions from students (anonymous), ${questions.length} in all. Downloaded ${t(new Date().toISOString())}.`, '',
      ...pages.flatMap(p => [`## Page ${p + 1}`, '', ...questions.filter(q => q.page_no === p).flatMap(q => [
        `- **${kindOf(q) === 'comment' ? 'Comment' : 'Question'}** (${t(q.created_at)}${q.status === 'hidden' ? ', hidden' : q.status === 'answered' ? ', done' : ''}): ${q.text.replace(/\n/g, ' ')}`,
        ...(q.answer ? [`  - *Reply:* ${q.answer.replace(/\n/g, ' ')}`] : []),
      ]), ''])].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `${L.course_code} ${L.title} - questions.md`.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // questions are watched whenever a lecture is chosen and the lecturer is signed in
  const watchWrap = f => async (...a) => { const r = await f(...a); watchQuestions(); return r; };
  login = watchWrap(login);
  logout = watchWrap(logout);
  const choose0 = chooseLecture;
  chooseLecture = async (l, o) => { await choose0(l, o); watchQuestions(); };
  if (S.lecture) refreshUser().then(async () => {
    watchQuestions();
    // the board was sending within the last 3 hours and was reloaded: carry on sending to the same
    // lecture (only from its own board, and only after the board has loaded its pages)
    const at = app.settings.sendLiveAt || 0;
    if (S.user && Date.now() - at < 3 * 3600e3 && app.settings.boardLecture === S.lecture.id) {
      await app.sessionReady;
      startLive();
      app.toast(`Sending to "${S.lecture.title}" resumed`);
    }
  }).catch(() => {});

  renderBtn();
  // an image (slide, figure) to Supabase Storage, bucket ink2latex, in the lecturer's own folder;
  // returns its public web address, or null when not signed in
  async function uploadImage(blob) {
    if (!S.user) await refreshUser().catch(() => {});
    if (!S.user) return null;
    const c = await client();
    const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
    const path = `${S.user.id}/${crypto.randomUUID()}.${ext}`;
    const { error } = await c.storage.from('ink2latex').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false });
    if (error) throw error;
    return c.storage.from('ink2latex').getPublicUrl(path).data.publicUrl;
  }

  // Settings → Students: the rules for a course (null when not signed in as lecturer)
  async function courseSettings(code) {
    if (!S.user) await refreshUser().catch(() => {});
    if (!S.user) return null;
    const { data, error } = await (await client()).from('course_settings').select('student_ai').eq('owner', S.user.id).eq('course_code', code).maybeSingle();
    if (error) throw error;
    return data?.student_ai || {};
  }
  async function saveCourseSettings(code, ai) {
    if (!S.user) throw new Error('not signed in');
    const { error } = await (await client()).from('course_settings')
      .upsert({ owner: S.user.id, course_code: code, student_ai: ai, updated_at: new Date().toISOString() }, { onConflict: 'owner,course_code' });
    if (error) throw error;
  }

  // an HTML file (Insert HTML) to Storage, stored as plain text (the apps put it in a sandboxed
  // iframe with srcdoc); returns its web address, or null when not signed in
  async function uploadText(text) {
    if (!S.user) await refreshUser().catch(() => {});
    if (!S.user) return null;
    const c = await client();
    const path = `${S.user.id}/${crypto.randomUUID()}.html`;
    const { error } = await c.storage.from('ink2latex').upload(path, new Blob([text], { type: 'text/plain' }), { contentType: 'text/plain', cacheControl: '31536000', upsert: false });
    if (error) throw error;
    return c.storage.from('ink2latex').getPublicUrl(path).data.publicUrl;
  }

  // the login's token, for the cloud AI (Edge Function); null when not signed in as lecturer
  async function accessToken() {
    if (!S.user) await refreshUser().catch(() => {});
    if (!S.user) return null;
    const { data } = await (await client()).auth.getSession();
    return data.session?.access_token || null;
  }
  // the database client while signed in as lecturer (assignments), else null
  async function db() {
    if (!S.user) await refreshUser().catch(() => {});
    return S.user ? client() : null;
  }
  return { db, cloudBoard, changed, isLive: () => S.live, push, renderDots: () => renderDots(), accessToken, uploadImage, uploadText, courseSettings, saveCourseSettings };
}

