// Assignments: the lecturer gives pages of a lecture to its students; each student works on their own
// copy and hands it in ("📤 Transmit", versions 1, 2, …); the lecturer opens a hand-in, writes on
// it and returns it ("↩ Return"); the student sees the feedback over the version they handed in.
//
// Every one of these is a board of its own, opened with the app's switchBoard (settings.boardLecture):
//   'asg:<assignment id>'  a student's work on an assignment (this browser + assignment_boards)
//   'ret:<feedback id>'    a student's view of feedback: their hand-in with the lecturer's ink on top
//   'rev:<submission id>'  the lecturer's review of a hand-in: the student's work locked, own ink on top
// What is locked (the task in an assignment, a student's work under review) is "flattened" by the app:
// the ink becomes a picture under the ink layer and the text boxes are locked (flattenPage).
// settings.asgCtx describes the board on screen when it is one of these (for the bar above the page).
// Tables (supabase-setup.sql): assignments, assignment_boards, submissions (insert-only), feedback.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = t => (t ? new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const KINDS = /^(asg|ret|rev):/;

export function initAssign(app) {
  // app: { settings, saveSettings, state, curPage, boardData(), switchBoard(id, opts), flattenPage(p, opts),
  //        uploadPending(), toast(msg), send, student, saveNow(), afterSwitch() }
  const $ = s => document.querySelector(s);
  const { settings } = app;
  const isStudent = () => !!app.student?.active();
  const ctx = () => (settings.asgCtx && settings.asgCtx.key === settings.boardLecture ? settings.asgCtx : null);

  async function db() {
    if (isStudent()) { await app.student.session(); return app.student.db(); }
    const c = await app.send.db();
    if (!c) throw new Error('Sign in under 📡 Send first.');
    return c;
  }
  const lecture = () => (isStudent() ? app.student.lecture() : settings.sendLecture);
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  // ------------------------------------------------------------------------------- opening boards
  async function open(key, meta, build) {
    if (isStudent()) await app.student.saveNow(); // the board being left, to the cloud
    settings.asgCtx = { key, ...meta };
    app.saveSettings();
    await app.switchBoard(key, { fetchCloud: build });
    sync();
  }
  // back to the board of the lecture (lecturer) or the student's own board of the lecture
  async function back() {
    if (isStudent()) await app.student.saveNow();
    const lec = lecture();
    delete settings.asgCtx;
    app.saveSettings();
    await app.switchBoard(isStudent() ? 'stu:' + lec.id : lec?.id || null, isStudent() ? { fetchCloud: () => app.student.loadBoard() } : { fetchCloud: app.send.cloudBoard });
    sync();
    app.send?.changed();
  }

  // a board for review / feedback: the hand-in flattened, the feedback's ink and boxes on top
  async function reviewBoard(sub, fb) {
    const data = sub.data || { pages: [] };
    const pages = [];
    for (const [i, p] of (data.pages || []).entries()) {
      const q = await app.flattenPage(p, { orientation: data.orientation });
      const f = fb?.data?.pages?.[i];
      if (f) { q.strokes = f.strokes || []; q.texts.push(...(f.texts || []).map(t => ({ ...t, lock: isStudent() }))); }
      pages.push(q);
    }
    return { app: 'ink2latex', version: 2, coords: 'page', orientation: data.orientation, saved: fb?.created_at || sub.created_at, pages };
  }

  // ------------------------------------------------------------------------------- the bar above the page
  function sync() {
    let chip = $('#asgChip');
    const c = ctx();
    if (!c) { chip?.remove(); document.body.classList.remove('asg-board'); return; }
    document.body.classList.add('asg-board');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'asgChip';
      $('#asgBtn').before(chip);
      chip.addEventListener('click', e => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'back') back();
        else if (a === 'transmit') openTransmit();
        else if (a === 'return') returnFeedback();
      });
    }
    chip.innerHTML = c.kind === 'asg'
      ? `📝 <b>${esc(c.title)}</b><button data-a="transmit" class="primary" title="Hand in a copy of all pages as they are now. You can keep working and hand in again (a new version).">📤 Transmit</button><button data-a="back" title="Back to your own board of the lecture">◀ My board</button>`
      : c.kind === 'ret'
        ? `📝 Feedback · <b>${esc(c.title)}</b> (version ${c.version})<button data-a="back" title="Back to your own board of the lecture">◀ My board</button>`
        : `📝 <b>${esc(c.name || 'Student')}</b> · ${esc(c.title)} · v${c.version}<button data-a="return" class="primary" title="Send your ink and text boxes on these pages back to the student">↩ Return</button><button data-a="back" title="Close the hand-in: back to the lecture's board">Close</button>`;
  }

  // ------------------------------------------------------------------------------- the dialog
  function shell(title, inner) {
    $('#asgView')?.remove();
    const v = document.createElement('div');
    v.id = 'asgView';
    v.innerHTML = `<div class="av-box"><div class="av-head"><strong>${title}</strong><span class="dim"></span>
      <button data-av="reload" title="Refresh">↻</button><button data-av="close" title="Close (Esc)">✕</button></div><div class="av-body">${inner}</div></div>`;
    document.body.appendChild(v);
    v.addEventListener('pointerdown', e => { if (e.target === v) close(); });
    return v;
  }
  function close() { $('#asgView')?.remove(); }
  const msg = (v, text) => { v.querySelector('.av-body').innerHTML = `<p class="dim">${esc(text)}</p>`; };

  async function openDialog() {
    const lec = lecture();
    if (!lec) { app.toast(isStudent() ? 'Join a lecture first' : 'Choose a lecture under 📡 Send first: assignments belong to a lecture'); return; }
    const v = shell(`📝 Assignments · ${esc(lec.title)}`, '<p class="dim">Loading…</p>');
    try { await (isStudent() ? renderStudent(v, lec) : renderLecturer(v, lec)); }
    catch (err) { msg(v, 'Could not load the assignments: ' + (err.message || err) + (/relation|does not exist|schema cache/i.test(err.message || '') ? ' (run supabase-setup.sql again)' : '')); }
  }

  // ---- lecturer: new assignment, the list, the hand-ins of each
  let openRows = new Set(); // assignments whose hand-ins are shown
  async function renderLecturer(v, lec) {
    const c = await db();
    const list = must(await c.from('assignments').select('id, title, due_at, open, created_at, page_count').eq('lecture_id', lec.id).order('created_at', { ascending: false }));
    const ids = list.map(a => a.id);
    const subs = ids.length ? must(await c.from('submissions').select('id, assignment_id, owner, version, name, note, created_at').in('assignment_id', ids).order('created_at')) : [];
    const fbs = subs.length ? must(await c.from('feedback').select('submission_id, created_at').in('submission_id', subs.map(s => s.id))) : [];
    const returned = new Map(fbs.map(f => [f.submission_id, f.created_at]));
    const n = app.state.pages.length, cur = app.state.cur + 1;
    const form = `<div class="av-new">
      <b>New assignment</b> from the pages of this board
      <div class="row"><input id="avTitle" placeholder="Title, e.g. Exercise 3: Fourier series" maxlength="200"></div>
      <div class="row">
        <label><input type="radio" name="avPages" value="cur" checked> this page (${cur})</label>
        <label><input type="radio" name="avPages" value="range"> pages <input id="avFrom" type="number" min="1" max="${n}" value="${cur}"> to <input id="avTo" type="number" min="1" max="${n}" value="${cur}"></label>
        <label>due <input id="avDue" type="datetime-local"></label>
        <button data-av="create" class="primary">Give to students</button>
      </div>
      <p class="dim">The students of this lecture find it under 📝 Assignments on their own board (✍ My board in the student app). Your writing on these pages is fixed into the pages: students write on top but cannot erase it. Tip: prepare exercise pages hidden from students (▦ Pages, 👁).</p>
    </div>`;
    const rows = list.map(a => {
      const mine = subs.filter(s => s.assignment_id === a.id);
      const latest = [...mine.reduce((m, s) => m.set(s.owner, s), new Map()).values()]; // the newest version of each student
      const late = s => a.due_at && s.created_at > a.due_at;
      const subRows = latest.map(s => `<tr><td>${esc(s.name || '(no name)')}</td><td>v${s.version}</td><td>${when(s.created_at)}${late(s) ? ' <span class="late">late</span>' : ''}</td>
        <td>${returned.has(s.id) ? '✓ returned' : ''}</td><td>${s.note ? `<span title="${esc(s.note)}">💬</span>` : ''}</td>
        <td><button data-av="review" data-id="${s.id}">Open</button></td></tr>`).join('');
      const shown = openRows.has(a.id);
      return `<div class="av-item" data-id="${a.id}">
        <div class="row"><b>${esc(a.title)}</b><span class="dim">${a.page_count} page${a.page_count === 1 ? '' : 's'} · given ${when(a.created_at)}${a.due_at ? ` · due ${when(a.due_at)}` : ''}</span>
          <label title="While open, students can hand in (again)"><input type="checkbox" data-av="open" ${a.open ? 'checked' : ''}> accepting hand-ins</label>
          <button data-av="subs">${shown ? '▾' : '▸'} Hand-ins (${latest.length})</button>
          <button data-av="del" title="Delete the assignment with all hand-ins and feedback">✕</button></div>
        ${shown ? (latest.length ? `<table class="av-subs"><tr><th>Name</th><th>Version</th><th>Handed in</th><th>Feedback</th><th></th><th></th></tr>${subRows}</table>` : '<p class="dim">No hand-ins yet.</p>') : ''}
      </div>`;
    }).join('');
    v.querySelector('.av-body').innerHTML = form + (rows || '<p class="dim">No assignments in this lecture yet.</p>');
    v.querySelector('.dim').textContent = `${list.length} assignment${list.length === 1 ? '' : 's'}`;
    v._subs = subs; v._list = list; v._returned = returned;
  }

  async function create(v) {
    const title = $('#avTitle').value.trim();
    if (!title) { $('#avTitle').focus(); app.toast('Give the assignment a title'); return; }
    const n = app.state.pages.length;
    let from = app.state.cur, to = app.state.cur;
    if (v.querySelector('[name=avPages]:checked').value === 'range') {
      from = Math.max(1, Math.min(n, +$('#avFrom').value || 1)) - 1;
      to = Math.max(from + 1, Math.min(n, +$('#avTo').value || n)) - 1;
    }
    const due = $('#avDue').value ? new Date($('#avDue').value).toISOString() : null;
    const btn = v.querySelector('[data-av=create]');
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      await app.uploadPending(); // slides, figures and HTML still only on this PC
      const pages = [];
      for (const p of app.state.pages.slice(from, to + 1)) pages.push(await app.flattenPage(p, { online: true, theme: 'white' }));
      const local = pages.some(p => p.images.some(i => i.src.startsWith('data:')) || p.panes.some(x => !x.src));
      if (local && !confirm('Some slides, figures or HTML could not be uploaded and are stored inside the assignment instead (larger). Give it anyway?')) return;
      const data = JSON.parse(JSON.stringify({ app: 'ink2latex', version: 2, coords: 'page', orientation: settings.orientation, saved: new Date().toISOString(), pages }, (k, x) => (k.startsWith('_') ? undefined : x)));
      const c = await db();
      must(await c.from('assignments').insert({ lecture_id: lecture().id, title, due_at: due, page_count: pages.length, data }));
      app.toast(`"${title}" given to the students (${pages.length} page${pages.length === 1 ? '' : 's'})`);
      await renderLecturer(v, lecture());
    } catch (err) { app.toast('Could not give the assignment: ' + (err.message || err)); }
    finally { btn.disabled = false; btn.textContent = 'Give to students'; }
  }

  async function openReview(v, id) {
    const sub0 = v._subs.find(s => s.id === id);
    const a = v._list.find(x => x.id === sub0.assignment_id);
    const c = await db();
    const sub = must(await c.from('submissions').select('*').eq('id', id).single());
    close();
    await open('rev:' + id, { kind: 'rev', id, title: a.title, version: sub.version, name: sub.name, note: sub.note }, () => reviewBoard(sub));
    if (sub.note) app.toast(`Note from the student: ${sub.note}`);
  }

  async function returnFeedback() {
    const c0 = ctx();
    if (!c0 || c0.kind !== 'rev') return;
    const pages = app.boardData().pages.map(p => ({ strokes: p.strokes, texts: (p.texts || []).filter(t => !t.lock) }));
    if (!pages.some(p => p.strokes.length || p.texts.length) && !confirm('You have not written anything on this hand-in. Return it anyway (as seen)?')) return;
    try {
      const c = await db();
      must(await c.from('feedback').insert({ submission_id: c0.id, data: { pages } }));
      app.toast(`Returned to ${c0.name || 'the student'}. They see your ink over version ${c0.version}.`);
    } catch (err) { app.toast('Could not return it: ' + (err.message || err)); }
  }

  // ---- student: the lecture's assignments, open one, see feedback
  async function renderStudent(v, lec) {
    const c = await db();
    const uid = (await app.student.session()).user.id;
    const list = must(await c.from('assignments').select('id, title, due_at, open, created_at').eq('lecture_id', lec.id).order('created_at', { ascending: false }));
    const ids = list.map(a => a.id);
    const subs = ids.length ? must(await c.from('submissions').select('id, assignment_id, version, created_at').in('assignment_id', ids).eq('owner', uid).order('version')) : [];
    const fbs = subs.length ? must(await c.from('feedback').select('id, submission_id, created_at').in('submission_id', subs.map(s => s.id)).order('created_at')) : [];
    const rows = list.map(a => {
      const mine = subs.filter(s => s.assignment_id === a.id), last = mine.at(-1);
      const fb = fbs.filter(f => mine.some(s => s.id === f.submission_id)).at(-1);
      const fbSub = fb && mine.find(s => s.id === fb.submission_id);
      const status = last ? `handed in: version ${last.version}, ${when(last.created_at)}` : 'not handed in yet';
      return `<div class="av-item" data-id="${a.id}"><div class="row"><b>${esc(a.title)}</b>
        <span class="dim">${a.due_at ? `due ${when(a.due_at)} · ` : ''}${status}${a.open ? '' : ' · closed'}</span>
        <button data-av="work" class="primary">${last ? 'Continue' : 'Open'}</button>
        ${fb ? `<button data-av="feedback" data-fb="${fb.id}" data-sub="${fbSub.id}" data-ver="${fbSub.version}">✓ Feedback (v${fbSub.version})</button>` : ''}</div></div>`;
    }).join('');
    v.querySelector('.av-body').innerHTML = rows || '<p class="dim">No assignments in this lecture yet.</p>';
    v.querySelector('.dim').textContent = 'Each assignment is a board of its own. 📤 Transmit hands in a copy; you can hand in again.';
    v._list = list;
    badge(list.filter(a => a.open && !subs.some(s => s.assignment_id === a.id)).length);
  }

  async function openWork(v, id) {
    const a = v._list.find(x => x.id === id);
    const c = await db();
    close();
    await open('asg:' + id, { kind: 'asg', id, title: a.title }, async () => {
      const own = must(await c.from('assignment_boards').select('data').eq('assignment_id', id).maybeSingle());
      if (own?.data) return own.data;
      const full = must(await c.from('assignments').select('data, created_at').eq('id', id).single());
      return { ...full.data, saved: full.created_at };
    });
  }

  async function openFeedback(v, b) {
    const a = v._list.find(x => x.id === b.closest('.av-item').dataset.id);
    const c = await db();
    const [sub, fb] = await Promise.all([
      c.from('submissions').select('*').eq('id', b.dataset.sub).single().then(must),
      c.from('feedback').select('*').eq('id', b.dataset.fb).single().then(must),
    ]);
    close();
    await open('ret:' + fb.id, { kind: 'ret', id: fb.id, title: a.title, version: sub.version }, () => reviewBoard(sub, fb));
  }

  // ---- 📤 Transmit
  function openTransmit() {
    const c0 = ctx();
    if (!c0 || c0.kind !== 'asg') return;
    const v = shell(`📤 Hand in · ${esc(c0.title)}`, `<div class="av-new">
      <div class="row"><label>Your name and study number <input id="avName" maxlength="200" placeholder="e.g. Ada Lovelace, s123456" value="${esc(settings.studentName || '')}"></label></div>
      <div class="row"><label style="flex:1">Message to the lecturer (optional)<br><textarea id="avNote" rows="2" maxlength="2000"></textarea></label></div>
      <p class="dim">A copy of all ${app.state.pages.length} page${app.state.pages.length === 1 ? '' : 's'} as they are now is handed in. You can keep working and hand in again: the lecturer sees every version.</p>
      <div class="row"><button data-av="close">Cancel</button><button data-av="send" class="primary">📤 Transmit</button></div></div>`);
    v.querySelector('.av-head .dim').textContent = '';
    v.querySelector('[data-av=reload]').hidden = true;
    setTimeout(() => $('#avName')?.focus(), 50);
  }
  async function transmit(v) {
    const c0 = ctx();
    const name = $('#avName').value.trim(), note = $('#avNote').value.trim();
    if (!name) { $('#avName').focus(); app.toast('Write your name and study number'); return; }
    settings.studentName = name; app.saveSettings();
    const btn = v.querySelector('[data-av=send]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      app.saveNow?.();
      const data = app.boardData();
      if (JSON.stringify(data).length > 29e6) throw new Error('too large (big photos or figures on the pages?)');
      const c = await db();
      const row = must(await c.from('submissions').insert({ assignment_id: c0.id, name, note: note || null, data }).select('version, created_at').single());
      await app.student.saveNow();
      close();
      app.toast(`Handed in: version ${row.version}. You can keep working and hand in again.`);
    } catch (err) {
      btn.disabled = false; btn.textContent = '📤 Transmit';
      app.toast('Not handed in: ' + (/row-level|policy/i.test(err.message || '') ? 'the assignment is closed for hand-ins' : err.message || err));
    }
  }

  // ---- the count of open assignments not handed in yet, on the button (students)
  function badge(n) {
    const b = $('#asgBtn');
    b.querySelector('.asg-n')?.remove();
    if (n > 0) b.insertAdjacentHTML('beforeend', `<span class="asg-n">${n}</span>`);
  }
  async function refreshBadge() {
    if (!isStudent()) return;
    try {
      const c = await db(), lec = lecture(), uid = (await app.student.session()).user.id;
      const list = must(await c.from('assignments').select('id').eq('lecture_id', lec.id).eq('open', true));
      const subs = list.length ? must(await c.from('submissions').select('assignment_id').in('assignment_id', list.map(a => a.id)).eq('owner', uid)) : [];
      badge(list.filter(a => !subs.some(s => s.assignment_id === a.id)).length);
    } catch { /* not set up yet */ }
  }

  // ------------------------------------------------------------------------------- events
  document.addEventListener('click', async e => {
    const b = e.target.closest?.('#asgView [data-av]');
    if (!b) return;
    const v = $('#asgView'), a = b.dataset.av, item = b.closest('.av-item');
    try {
      if (a === 'close') close();
      else if (a === 'reload') openDialog();
      else if (a === 'create') await create(v);
      else if (a === 'subs') { const id = item.dataset.id; openRows.has(id) ? openRows.delete(id) : openRows.add(id); await renderLecturer(v, lecture()); }
      else if (a === 'review') await openReview(v, b.dataset.id);
      else if (a === 'del') {
        const t = v._list.find(x => x.id === item.dataset.id);
        const n = v._subs.filter(s => s.assignment_id === t.id).length;
        if (!confirm(`Delete "${t.title}"${n ? ` with its ${n} hand-in${n === 1 ? '' : 's'} and all feedback` : ''}? This cannot be undone.`)) return;
        must(await (await db()).from('assignments').delete().eq('id', t.id));
        await renderLecturer(v, lecture());
      }
      else if (a === 'work') await openWork(v, item.dataset.id);
      else if (a === 'feedback') await openFeedback(v, b);
      else if (a === 'send') await transmit(v);
    } catch (err) { app.toast(err.message || String(err)); }
  });
  document.addEventListener('change', async e => {
    const b = e.target.closest?.('#asgView [data-av=open]');
    if (!b) return;
    try { must(await (await db()).from('assignments').update({ open: b.checked }).eq('id', b.closest('.av-item').dataset.id)); app.toast(b.checked ? 'Students can hand in' : 'Closed: no more hand-ins'); }
    catch (err) { b.checked = !b.checked; app.toast(err.message || String(err)); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#asgView') && !e.target.closest?.('input, textarea')) close(); });
  $('#asgBtn').addEventListener('click', openDialog);
  setInterval(refreshBadge, 120000);

  return { sync, openDialog, close, refreshBadge, ctx, quiet: () => /^(rev|ret):/.test(settings.boardLecture || ''), isBoard: key => KINDS.test(key || '') };
}
