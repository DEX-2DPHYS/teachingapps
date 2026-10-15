// Voice input (🎤 / V): speak to write text on the board or to correct a region.
//
//   record (MediaRecorder, any browser)  ->  task "speech" (Voxtral / gpt-4o-transcribe)
//   ->  "voicefix" (change the region's reading as spoken) or "dictate" (text for a new text box)
//       or, for an instruction that names content ("insert the Hencky solution …"), "compose" (the AI writes it)
//   ->  a card shows what was heard and the result; nothing changes until Apply (Enter).
//
// The ink stays the source of truth: a correction only edits the region's reading (undo: the
// region card's "↶ original"), a dictation is an ordinary text box.
// app.js passes what it knows in d: target(), context(), insertText(), applyFix(), allowed(), ...

const LANGS = [['', 'Auto (English / Dansk)'], ['en', 'English'], ['da', 'Dansk']];
const MAX_SECS = 60;

export function initVoice(d) {
  const { api, toast, esc, settings, saveSettings } = d;
  let rec = null;   // { stream, mr, chunks, t0, raf, ctx, timer, cancelled }
  let card = null;  // the card element
  let S = null;     // what the card shows: { stage, transcript, mode, target, result, seq, secs }
  let seq = 0;

  const supported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const lang = () => settings.voiceLang || '';

  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.id = 'voiceCard';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Voice input');
    document.body.appendChild(card);
    card.addEventListener('pointerdown', e => e.stopPropagation());
    return card;
  }
  function closeCard() {
    card?.remove(); card = null; S = null;
    d.highlight(null);
  }

  // ---------------------------------------------------------------- recording
  async function start() {
    if (rec) return;
    const ok = d.allowed();
    if (!ok.ok) { toast(ok.why); return; }
    if (!supported()) { toast('This browser cannot record audio'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (err) { toast(/denied|permission/i.test(err.name + err.message) ? 'The microphone is blocked: allow it for this page (the lock icon next to the address)' : `No microphone: ${err.message || err.name}`); return; }
    const target = d.target();
    d.highlight(target?.box || null);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported?.(m)) || '';
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    rec = { stream, mr, chunks: [], t0: performance.now(), cancelled: false };
    mr.ondataavailable = e => { if (e.data?.size) rec.chunks.push(e.data); };
    mr.onstop = () => finishRecording();
    mr.start(250);
    // a level meter, so it is plain that the microphone hears
    try {
      rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = rec.ctx.createAnalyser(); an.fftSize = 512;
      rec.ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!rec) return;
        an.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        const lv = card?.querySelector('.vc-level i'); if (lv) lv.style.width = Math.min(100, peak / 128 * 140) + '%';
        const secs = (performance.now() - rec.t0) / 1000;
        const tm = card?.querySelector('.vc-time'); if (tm) tm.textContent = `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
        if (secs >= MAX_SECS) { stop(); return; }
        rec.raf = requestAnimationFrame(tick);
      };
      rec.raf = requestAnimationFrame(tick);
    } catch { /* no meter */ }
    S = { stage: 'rec', target, seq: ++seq };
    render();
  }
  function stop() { if (rec?.mr.state === 'recording') rec.mr.stop(); }
  function cancel() {
    if (rec) { rec.cancelled = true; stop(); if (rec.mr.state !== 'recording') release(); }
    seq++; // answers still on their way are dropped
    closeCard();
  }
  function release() {
    if (!rec) return;
    cancelAnimationFrame(rec.raf);
    rec.stream.getTracks().forEach(t => t.stop());
    rec.ctx?.close?.().catch(() => {});
    rec = null;
  }
  async function finishRecording() {
    const r = rec, secs = (performance.now() - r.t0) / 1000;
    release();
    if (r.cancelled) return;
    if (secs < 0.5) { toast('Too short: press 🎤 (or V), speak, press again'); closeCard(); return; }
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    const mySeq = S.seq;
    S.stage = 'busy'; S.msg = 'Transcribing…'; render();
    try {
      const audio = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(blob); });
      const j = await api({ task: 'speech', model: settings.finalModel, audio, mediaType: blob.type || 'audio/webm', lang: lang(), secs: Math.round(secs * 10) / 10 });
      if (S?.seq !== mySeq) return;
      const text = (j.data.text || '').trim();
      if (!text) { toast('Nothing heard: speak closer to the microphone'); closeCard(); return; }
      S.transcript = text; S.secs = secs; S.heardLang = j.data.language || '';
      S.mode = S.target ? 'auto' : 'write'; S.auto = true; // auto: an instruction switches to "Do as I say" by itself
      run();
    } catch (err) {
      if (S?.seq !== mySeq) return;
      toast('Speech input failed: ' + (err.message || err));
      closeCard();
    }
  }

  // ---------------------------------------------------------------- understanding it
  async function run() {
    const my = ++seq;
    S.seq = my; S.stage = 'busy'; S.result = null;
    const l = lang() || S.heardLang || '';
    const lg = /^(en|da)/i.test(l) ? l.slice(0, 2).toLowerCase() : '';
    try {
      let mode = S.mode;
      if (mode === 'auto' || mode === 'fix') {
        S.msg = 'Working out the change…'; render();
        const t = S.target;
        const j = await api({ task: 'voicefix', model: settings.finalModel, kind: t.kind, expr: t.source, speech: S.transcript, lang: lg, context: d.context(t.b) });
        if (S?.seq !== my) return;
        if (j.data.changed && j.data.new_source && j.data.new_source !== t.source) { S.mode = 'fix'; S.result = { fix: j.data }; }
        else if (mode === 'fix') { S.result = { fix: { ...j.data, changed: false } }; }
        else mode = 'write'; // not a correction: it is something to write
      }
      if (mode === 'write' || mode === 'ask') {
        if (!S.dict || S.dictFor !== S.transcript) { // kept, so switching between the two modes costs nothing
          S.msg = 'Writing it up…'; render();
          const j = await api({ task: 'dictate', model: settings.liveModel, speech: S.transcript, lang: lg, context: d.context(null) });
          if (S?.seq !== my) return;
          S.dict = j.data; S.dictFor = S.transcript; S.composed = null;
        }
        const askWhy = d.canAsk?.() || '';
        if (mode === 'write' && S.auto && (S.dict.request || '').trim() && !askWhy) mode = 'ask';
        if (mode === 'write') { S.mode = 'write'; S.result = { write: S.dict }; }
        else if (askWhy) { S.mode = 'ask'; S.result = { error: askWhy }; }
        else {
          if (!S.composed) {
            const request = (S.dict.request || '').trim() || S.transcript;
            S.msg = 'Doing what you asked…'; S.mode = 'ask'; render();
            const j = await api({ task: 'compose', model: d.askModel?.() || settings.finalModel, speech: request, lang: lg, context: d.context(null) });
            if (S?.seq !== my) return;
            S.composed = j.data;
          }
          S.mode = 'ask'; S.result = { write: S.composed, asked: true };
        }
      }
      S.stage = 'result'; render();
    } catch (err) {
      if (S?.seq !== my) return;
      S.stage = 'result'; S.result = { error: err.message || String(err) }; render();
    }
  }

  function apply() {
    if (!S || S.stage !== 'result' || !S.result) return;
    const r = S.result;
    if (r.write?.text) { d.insertText(r.write.text); toast((r.asked ? 'Inserted (written by the AI). ' : 'Text written. ') + 'Move it with ✥, edit it with the T tool.'); }
    else if (r.fix?.changed) { d.applyFix(S.target, r.fix.new_source); toast('Changed: ' + (r.fix.summary || 'region corrected') + ' (the region card has ↶ original)'); }
    else return;
    closeCard();
  }

  // ---------------------------------------------------------------- the card
  function preview(kind, src) { return kind === 'math' ? d.tex(src, false) : d.mixed(src); }
  function render() {
    if (!S) return;
    const c = ensureCard();
    const sel = `<select class="vc-lang" title="Language of the speech">${LANGS.map(([v, n]) => `<option value="${v}"${v === lang() ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    let html;
    if (S.stage === 'rec') {
      html = `<div class="vc-row"><span class="vc-dot"></span><span class="vc-time">0:00</span><span class="vc-level"><i></i></span>${sel}
        <button class="vc-main" data-a="stop" title="Stop (V)">Stop</button><button data-a="cancel" title="Cancel (Esc)">✕</button></div>
        <div class="vc-hint">${S.target ? 'Speak: a correction of the highlighted region ("change the exponent to three"), or text to write.' : 'Speak the text to write (maths in words: "integral from zero to infinity of x squared …").'}</div>`;
    } else if (S.stage === 'busy') {
      html = `<div class="vc-row"><span class="vc-spin"></span><span>${esc(S.msg || '…')}</span>${S.transcript ? `<em class="vc-heard">“${esc(S.transcript)}”</em>` : ''}<button data-a="cancel" title="Cancel (Esc)">✕</button></div>`;
    } else {
      const r = S.result || {};
      const t = S.target;
      let body = '';
      if (r.error) body = `<div class="vc-err">${esc(r.error)}</div>`;
      else if (r.write) body = (r.asked ? `<div class="vc-ai${r.write.confident === false ? ' unsure' : ''}">✦ Written by the AI from your instruction${r.write.confident === false ? ': it is NOT sure, check it' : ': check it before you teach from it'}</div>` : '')
        + `<div class="vc-prev">${d.mixed(r.write.text || '')}</div>${r.write.note ? `<div class="vc-note">${esc(r.write.note)}</div>` : ''}`;
      else if (r.fix?.changed) body = `<div class="vc-prev"><span class="vc-old">${preview(t.kind, t.source)}</span> <b>→</b> ${preview(t.kind, r.fix.new_source)}</div><div class="vc-note">${esc(r.fix.summary || '')}</div>`;
      else if (r.fix) body = `<div class="vc-note">No change made: ${esc(r.fix.summary || 'the instruction did not match this region')}</div>`;
      const can = !!(r.write?.text || r.fix?.changed);
      html = `<div class="vc-row"><textarea class="vc-text" rows="2" title="What was heard: edit it if it is wrong, then click outside to redo">${esc(S.transcript || '')}</textarea></div>
        <div class="vc-row vc-modes">
          <label title="Write down what you said (maths in words becomes formulas)"><input type="radio" name="vcm" value="write"${S.mode === 'write' ? ' checked' : ''}> ✎ Write as text</label>
          <label title="Carry out what you said: 'insert the Hencky solution for …' – the AI writes the named content"><input type="radio" name="vcm" value="ask"${S.mode === 'ask' ? ' checked' : ''}> ✦ Do as I say</label>
          <label class="${t ? '' : 'off'}"><input type="radio" name="vcm" value="fix"${S.mode === 'fix' ? ' checked' : ''}${t ? '' : ' disabled'}> ✏ Correct the region${t ? ` <span class="vc-tgt">${preview(t.kind, t.source.slice(0, 80))}</span>` : ' (hover the pen over one first)'}</label>
        </div>${body}
        <div class="vc-row"><button class="vc-main" data-a="apply"${can ? '' : ' disabled'} title="Enter">${S.mode === 'fix' ? 'Apply' : 'Insert'}</button>
          <button data-a="again" title="Record again (V)">🎤 Again</button>${sel}<button data-a="cancel" title="Esc">Discard</button></div>`;
    }
    c.innerHTML = html;
    d.typeset?.(c);
  }
  document.addEventListener('click', e => {
    const b = e.target.closest?.('#voiceCard [data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'stop') stop(); else if (a === 'cancel') cancel(); else if (a === 'apply') apply();
    else if (a === 'again') { closeCard(); start(); }
  });
  document.addEventListener('change', e => {
    if (!card || !card.contains(e.target)) return;
    if (e.target.classList.contains('vc-lang')) { settings.voiceLang = e.target.value; saveSettings(); }
    else if (e.target.name === 'vcm' && S) { S.mode = e.target.value; S.auto = false; run(); }
    else if (e.target.classList.contains('vc-text') && S && S.transcript !== e.target.value.trim() && e.target.value.trim()) {
      S.transcript = e.target.value.trim();
      if (S.auto) S.mode = S.target ? 'auto' : 'write';
      run();
    }
  });
  document.addEventListener('keydown', e => {
    if (!card) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'BUTTON') { if (e.target.tagName === 'TEXTAREA') e.target.blur(); if (S?.stage === 'result') { e.preventDefault(); e.stopPropagation(); setTimeout(apply, 0); } }
  }, true);

  return {
    toggle() { if (rec) stop(); else { closeCard(); start(); } },
    cancel, supported, active: () => !!card,
  };
}
