const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DURATION_MS = 60 * 60 * 1000;   // 60 minutes
const GRACE_MS = 3000;                // network-latency grace for last answer/submit
const db = new Database('test.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS students(reg_no TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions(id INTEGER PRIMARY KEY, text TEXT NOT NULL,
  a TEXT NOT NULL, b TEXT NOT NULL, c TEXT NOT NULL, d TEXT NOT NULL,
  correct TEXT NOT NULL CHECK(correct IN('a','b','c','d')));
CREATE TABLE IF NOT EXISTS attempts(reg_no TEXT PRIMARY KEY REFERENCES students(reg_no),
  started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, qorder TEXT NOT NULL,
  submitted_at INTEGER, score INTEGER, auto_submitted INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS answers(reg_no TEXT NOT NULL REFERENCES students(reg_no),
  question_id INTEGER NOT NULL REFERENCES questions(id), choice TEXT NOT NULL CHECK(choice IN('a','b','c','d')),
  PRIMARY KEY(reg_no, question_id));
`);

// ---- CLI helpers -------------------------------------------------------
if (process.argv.includes('--seed')) {
  const q = db.prepare('INSERT OR REPLACE INTO questions VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (let i = 1; i <= 100; i++)   // SAMPLE DATA: replace with your real questions
      q.run(i, `Sample question ${i}: what is ${i} + ${i}?`, String(i * 2), String(i * 2 + 1), String(i * 2 - 1), String(i), 'a');
    const s = db.prepare('INSERT OR IGNORE INTO students VALUES(?,?)');
    s.run('2024-CS-001', 'Test Student One'); s.run('2024-CS-002', 'Test Student Two');
  })();
  console.log('Seeded 100 sample questions and 2 students.'); process.exit();
}
if (process.argv.includes('--results')) {
  console.log('reg_no,name,score,submitted_at,auto_submitted');
  for (const r of db.prepare(`SELECT a.reg_no,s.name,a.score,a.submitted_at,a.auto_submitted FROM attempts a JOIN students s USING(reg_no)`).all())
    console.log([r.reg_no, JSON.stringify(r.name), r.score ?? '', r.submitted_at ? new Date(r.submitted_at).toISOString() : '', r.auto_submitted].join(','));
  process.exit();
}

// ---- Core logic --------------------------------------------------------
const scoreStmt = db.prepare(`SELECT COUNT(*) n FROM answers a JOIN questions q ON q.id=a.question_id AND q.correct=a.choice WHERE a.reg_no=?`);
const finalizeStmt = db.prepare(`UPDATE attempts SET submitted_at=?, score=?, auto_submitted=? WHERE reg_no=? AND submitted_at IS NULL`);
const finalize = db.transaction((reg, auto) => {       // atomic + idempotent: first finalize wins
  finalizeStmt.run(Date.now(), scoreStmt.get(reg).n, auto ? 1 : 0, reg);
  return db.prepare('SELECT * FROM attempts WHERE reg_no=?').get(reg);
});
const getAttempt = reg => {
  let a = db.prepare('SELECT * FROM attempts WHERE reg_no=?').get(reg);
  if (a && !a.submitted_at && Date.now() > a.deadline + GRACE_MS) a = finalize(reg, true);
  return a;
};
// Sweeper: scores expired attempts even if the student closed the browser
setInterval(() => {
  for (const r of db.prepare('SELECT reg_no FROM attempts WHERE submitted_at IS NULL AND deadline+?<?').all(GRACE_MS, Date.now()))
    finalize(r.reg_no, true);
}, 15000);

function testPayload(a) {
  const ids = JSON.parse(a.qorder), qs = db.prepare('SELECT id,text,a,b,c,d FROM questions').all();
  const byId = new Map(qs.map(q => [q.id, q]));       // correct answers are never sent
  const answers = {};
  for (const r of db.prepare('SELECT question_id,choice FROM answers WHERE reg_no=?').all(a.reg_no)) answers[r.question_id] = r.choice;
  return { remainingMs: Math.max(0, a.deadline - Date.now()), answers,
    questions: ids.map(id => byId.get(id)).filter(Boolean).map(q => ({ id: q.id, text: q.text, options: { a: q.a, b: q.b, c: q.c, d: q.d } })) };
}

// ---- App ---------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());                                   // strict CSP, no inline scripts
app.use(express.json({ limit: '2kb' }));
app.use(session({
  name: 'sid', secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 2 * 3600e3 }
}));
app.use(express.static('public'));

const auth = (req, res, next) => req.session.reg ? next() : res.status(401).json({ error: 'Not logged in' });

app.post('/api/login', rateLimit({ windowMs: 60e3, max: 10 }), (req, res) => {
  const reg = String(req.body.reg || '').trim().toUpperCase();
  if (!/^[A-Z0-9\-\/]{3,24}$/.test(reg)) return res.status(400).json({ error: 'Invalid registration number format' });
  const s = db.prepare('SELECT * FROM students WHERE reg_no=?').get(reg);
  if (!s) return res.status(403).json({ error: 'Registration number not found' });
  req.session.regenerate(() => { req.session.reg = reg; res.json({ name: s.name }); });
});

app.get('/api/state', auth, (req, res) => {
  const reg = req.session.reg, s = db.prepare('SELECT name FROM students WHERE reg_no=?').get(reg), a = getAttempt(reg);
  res.json({ name: s.name, status: !a ? 'new' : a.submitted_at ? 'done' : 'running', score: a?.submitted_at ? a.score : null, total: 100 });
});

app.post('/api/start', auth, (req, res) => {        // creates the attempt once; later calls resume it
  const reg = req.session.reg, now = Date.now();
  if (!getAttempt(reg)) {
    const ids = db.prepare('SELECT id FROM questions').all().map(r => r.id);
    for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    db.prepare('INSERT OR IGNORE INTO attempts(reg_no,started_at,deadline,qorder) VALUES(?,?,?,?)').run(reg, now, now + DURATION_MS, JSON.stringify(ids));
  }
  const a = getAttempt(reg);
  if (a.submitted_at) return res.status(409).json({ error: 'Test already submitted', score: a.score });
  res.json(testPayload(a));
});

app.post('/api/answer', auth, rateLimit({ windowMs: 60e3, max: 300 }), (req, res) => {
  const a = getAttempt(req.session.reg), { qid, choice } = req.body;
  if (!a || a.submitted_at || Date.now() > a.deadline + GRACE_MS) return res.status(403).json({ error: 'Test closed' });
  if (!Number.isInteger(qid) || !['a', 'b', 'c', 'd'].includes(choice)) return res.status(400).json({ error: 'Bad input' });
  if (!JSON.parse(a.qorder).includes(qid)) return res.status(400).json({ error: 'Bad question' });
  db.prepare('INSERT INTO answers VALUES(?,?,?) ON CONFLICT(reg_no,question_id) DO UPDATE SET choice=excluded.choice').run(a.reg_no, qid, choice);
  res.json({ ok: true });
});

app.post('/api/submit', auth, (req, res) => {
  const a = getAttempt(req.session.reg);
  if (!a) return res.status(400).json({ error: 'No attempt' });
  const f = a.submitted_at ? a : finalize(a.reg_no, Date.now() > a.deadline);
  res.json({ score: f.score, total: 100 });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.listen(process.env.PORT || 3000, () => console.log('Running on http://localhost:' + (process.env.PORT || 3000)));
