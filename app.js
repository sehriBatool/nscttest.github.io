'use strict';
const $ = s => document.querySelector(s);
const show = id => { document.querySelectorAll('.screen').forEach(e => e.hidden = e.id !== id); };
async function api(path, body) {
  const r = await fetch('/api/' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status, data: j });
  return j;
}
let Q = [], ans = {}, cur = 0, endAt = 0, frozen = false, timerId;

async function route() {
  try {
    const s = await api('state');
    $('#hello').textContent = 'Welcome, ' + s.name;
    if (s.status === 'done') return finished(s.score, s.total);
    if (s.status === 'running') return begin();
    show('intro');
  } catch { show('login'); }
}
$('#loginBtn').onclick = async () => {
  $('#loginErr').textContent = '';
  try { await api('login', { reg: $('#reg').value }); route(); }
  catch (e) { $('#loginErr').textContent = e.message; }
};
$('#reg').onkeydown = e => { if (e.key === 'Enter') $('#loginBtn').click(); };
$('#startBtn').onclick = begin;

async function begin() {
  try {
    const t = await api('start', {});
    Q = t.questions; ans = t.answers; cur = 0;
    endAt = performance.now() + t.remainingMs;      // monotonic clock: immune to changing the PC clock
    show('test'); render(); timerId = setInterval(tick, 250); tick();
  } catch (e) { if (e.status === 409) finished(e.data.score, 100); else alert(e.message); }
}
function tick() {
  const left = Math.max(0, endAt - performance.now()), s = Math.ceil(left / 1000);
  $('#timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  $('#timer').classList.toggle('low', s <= 300);
  if (left <= 0 && !frozen) timeUp();
}
function render() {
  const q = Q[cur];
  $('#prog').textContent = `Question ${cur + 1} / ${Q.length} · Answered ${Object.keys(ans).length}`;
  $('#qtext').textContent = `${cur + 1}. ${q.text}`;
  const box = $('#opts'); box.replaceChildren();
  for (const k of ['a', 'b', 'c', 'd']) {
    const l = document.createElement('label'), i = document.createElement('input');
    l.className = 'opt' + (ans[q.id] === k ? ' sel' : '');
    i.type = 'radio'; i.name = 'o'; i.checked = ans[q.id] === k; i.disabled = frozen;
    i.onchange = () => choose(q.id, k);
    l.append(i, k.toUpperCase() + '. ' + q.options[k]); box.append(l);
  }
  $('#prev').disabled = cur === 0; $('#next').disabled = cur === Q.length - 1;
  const p = $('#palette'); p.replaceChildren();
  Q.forEach((x, n) => { const b = document.createElement('button'); b.textContent = n + 1;
    b.className = (ans[x.id] ? 'ans ' : '') + (n === cur ? 'cur' : ''); b.onclick = () => { cur = n; render(); }; p.append(b); });
}
$('#prev').onclick = () => { cur--; render(); };
$('#next').onclick = () => { cur++; render(); };

function choose(qid, c) { if (frozen) return; ans[qid] = c; render(); save(qid, c); }
async function save(qid, c, tries = 0) {              // autosave with retry so flaky Wi-Fi doesn't lose answers
  if (frozen && tries === 0) return;
  try { await api('answer', { qid, choice: c }); }
  catch (e) { if (e.status === 403 || e.status === 401) return; if (ans[qid] === c && tries < 20) setTimeout(() => save(qid, c, tries + 1), 2000); }
}
function modal(t, b) { $('#mTitle').textContent = t; $('#mBody').textContent = b; $('#modal').hidden = false; }

async function timeUp() {
  frozen = true; clearInterval(timerId);
  document.body.classList.add('frozen'); document.querySelectorAll('input,button').forEach(e => e.disabled = true);
  modal("⏰ Time's up!", 'Your test is frozen. Submitting your answers…');
  for (let i = 0; i < 10; i++) {
    try { const r = await api('submit', {}); $('#modal').hidden = true; return finished(r.score, r.total); }
    catch { await new Promise(r => setTimeout(r, 1500)); }
  }
  modal("⏰ Time's up!", 'Connection problem. Your saved answers will be scored automatically by the server.');
}
$('#submitBtn').onclick = async () => {
  const left = Q.length - Object.keys(ans).length;
  if (!confirm(left ? `${left} question(s) unanswered. Submit anyway?` : 'Submit your test now?')) return;
  frozen = true; clearInterval(timerId);
  try { const r = await api('submit', {}); finished(r.score, r.total); } catch (e) { frozen = false; timerId = setInterval(tick, 250); alert('Submit failed, try again: ' + e.message); }
};
function finished(score, total) { frozen = true; clearInterval(timerId); onbeforeunload = null; document.body.classList.remove('frozen'); $('#modal').hidden = true; $('#result').textContent = `Your score: ${score} / ${total}`; show('done'); }
onbeforeunload = e => { if (!frozen && Q.length) { e.preventDefault(); e.returnValue = ''; } };
document.addEventListener('contextmenu', e => e.preventDefault());
route();
