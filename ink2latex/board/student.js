// Student mode of the whiteboard. A student opens the whiteboard with ?join=CODE (the "✎ My
// whiteboard" button in the student app): they get the same whiteboard as the lecturer, on a board of
// their own per lecture, saved privately (this browser + table ink2latex.student_boards). The AI runs
// through the cloud function under the lecturer's rules for the course (Settings → Students).
// The login is the same anonymous student login the student app uses (storage key ink2latex-student),
// so on one device a student is one person: their notes, questions and board belong together.

import { SUPABASE_URL, SUPABASE_KEY, SCHEMA, LIBS } from '../config.js?v=2026-10-06.0545';

let sb = null;
async function client() {
  if (!sb) {
    const { createClient } = await import(LIBS.supabase);
    sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      db: { schema: SCHEMA },
      auth: { storageKey: 'ink2latex-student', persistSession: true, autoRefreshToken: true },
    });
  }
  return sb;
}

export function initStudent(app) {
  // app: { settings, saveSettings, boardData(), toast(msg) }
  const S = { lecture: app.settings.studentLecture || null, rules: null };

  async function session() {
    const c = await client();
    let { data } = await c.auth.getSession();
    if (!data.session) {
      const { error } = await c.auth.signInAnonymously();
      if (error) throw error;
      ({ data } = await c.auth.getSession());
    }
    return data.session;
  }

  async function join(code) {
    code = String(code || '').trim().toUpperCase();
    await session();
    const c = await client();
    const { data, error } = await c.rpc('join_lecture', { code });
    if (error) throw error;
    if (!data?.length) throw new Error('No lecture with that code.');
    S.lecture = { id: data[0].id, title: data[0].title, course_code: data[0].course_code, code };
    app.settings.studentLecture = S.lecture;
    app.saveSettings();
    return S.lecture;
  }

  function leave() {
    delete app.settings.studentLecture;
    app.saveSettings();
    S.lecture = null;
  }

  async function accessToken() {
    try { return (await session())?.access_token || null; } catch { return null; }
  }

  // ---- the student's board in the cloud (private): loaded when opening the lecture, saved ~20 s
  // after changes and when leaving the page
  async function loadBoard() {
    if (!S.lecture) return null;
    await session();
    const { data } = await (await client()).from('student_boards').select('data').eq('lecture_id', S.lecture.id).maybeSingle();
    return data?.data || null;
  }
  // the board on screen decides where it goes: 'stu:<lecture>' = the student's board of the lecture,
  // 'asg:<assignment>' = their work on an assignment (assign.js); feedback views are not saved
  let timer = 0;
  async function saveNow() {
    clearTimeout(timer);
    if (!S.lecture) return;
    const key = app.settings.boardLecture || '';
    try {
      const s = await session(), c = await client(), now = new Date().toISOString();
      let r = null;
      if (key === 'stu:' + S.lecture.id) r = await c.from('student_boards').upsert({ owner: s.user.id, lecture_id: S.lecture.id, data: app.boardData(), updated_at: now }, { onConflict: 'owner,lecture_id' });
      else if (key.startsWith('asg:')) r = await c.from('assignment_boards').upsert({ owner: s.user.id, assignment_id: key.slice(4), data: app.boardData(), updated_at: now }, { onConflict: 'owner,assignment_id' });
      if (r?.error) console.warn('student board:', r.error.message);
    } catch (err) { console.warn('student board:', err); }
  }
  function changed() {
    if (!S.lecture) return;
    clearTimeout(timer);
    timer = setTimeout(saveNow, 20000);
  }
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

  return {
    active: () => !!S.lecture,
    lecture: () => S.lecture,
    rules: () => S.rules,
    setRules: r => { S.rules = r; },
    join, leave, accessToken, loadBoard, saveNow, changed, session, db: client,
  };
}
