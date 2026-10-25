// Messungen Phase 3 (Lernmodi): neue Abfragen bei 2 000 Quellen / 40 000 Abschnitten, 10 000 Karten, 50 000 Wiederholungen,
// 4 000 Quizfragen, 2 000 Konzepten. Synchrone SQLite-Abfragen blockieren den Server -> jede Zeile = Event-Loop-Blockade.
//   node --disable-warning=ExperimentalWarning scripts/bench-learn.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { Library } from '../server/library.ts';
import { BlobStore } from '../server/storage.ts';
import { SqliteVectorStore } from '../server/embed/vector-store.ts';
import { EventBus } from '../server/events.ts';
import * as data from '../server/learn/data.ts';
import { loadScope } from '../server/learn/text.ts';

const dir = path.join(PROJECT_ROOT, '.tmp', 'bench-learn');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const db = openDb(path.join(dir, 'hotspot.sqlite'));
const DAY = 86_400_000;
const now = Date.now();
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const t0 = performance.now();
db.exec('BEGIN');
const subjects = Array.from({ length: 20 }, (_, i) => Number(db.prepare("INSERT INTO subjects(name, color, created_at) VALUES (?, '#39e6ff', 1)").run(`Fach ${i}`).lastInsertRowid));
const insSource = db.prepare("INSERT INTO sources(subject_id, sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, ?, 1, 'text/plain', 'text', 'ready', ?, 20)");
const insChunk = db.prepare("INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, token_est, embed_state) VALUES (?, ?, ?, ?, 'page', ?, ?, 200, 1)");
const insCard = db.prepare(
  'INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, chunk_id, source_name, reps, ease, interval_days, due, last_review, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 2.5, ?, ?, ?, 1, 1)',
);
const insReview = db.prepare('INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (?, ?, ?, 1, 2.5)');
const insQ = db.prepare("INSERT INTO quiz_questions(type, question, answer, explanation, topic, fingerprint, subject_id, source_id, chunk_id, source_name, created_at) VALUES ('short', ?, 'a', 'e', ?, ?, ?, ?, ?, ?, 1)");
const insA = db.prepare('INSERT INTO quiz_attempts(question_id, answer, score, created_at) VALUES (?, ?, ?, ?)');
const insCache = db.prepare('INSERT INTO learn_cache(key, source_id, value, created_at) VALUES (?, ?, ?, 1)');
const sources: number[] = [];
for (let i = 0; i < 2000; i++) {
  const sub = subjects[i % subjects.length]!;
  const sid = Number(insSource.run(sub, crypto.randomBytes(32).toString('hex'), `Quelle ${i}.txt`, i).lastInsertRowid);
  sources.push(sid);
  const chunkIds: number[] = [];
  for (let k = 0; k < 20; k++) chunkIds.push(Number(insChunk.run(sid, k, `Text ${i} ${k} Entropie Vektor ${'x'.repeat(400)}`, `Kapitel ${k % 4}`, k + 1, k + 1).lastInsertRowid));
  for (let k = 0; k < 5; k++) {
    const status = k === 4 ? 'draft' : 'active';
    const due = status === 'active' && k < 3 ? now + Math.round((rnd() * 60 - 30) * DAY) : null;
    const cid = Number(insCard.run('qa', `Frage ${i}.${k}`, `Antwort ${i}.${k}`, status, sub, sid, chunkIds[k], `Quelle ${i}.txt`, k, k, due, due ? now - DAY : null).lastInsertRowid);
    if (status === 'active') for (let r = 0; r < 6; r++) insReview.run(cid, 1 + Math.floor(rnd() * 4), now - Math.floor(rnd() * 180) * DAY);
  }
  for (let k = 0; k < 2; k++) {
    const qid = Number(insQ.run(`Frage ${i}-${k}?`, `Kapitel ${k}`, crypto.randomBytes(8).toString('hex'), sub, sid, chunkIds[k], `Quelle ${i}.txt`).lastInsertRowid);
    for (let a = 0; a < 5; a++) insA.run(qid, 'x', rnd() < 0.5 ? 0 : 1, now - a * DAY);
  }
  for (let k = 0; k < 2; k++) insCache.run(crypto.randomBytes(16).toString('hex'), sid, '"x"');
}
const insConcept = db.prepare('INSERT INTO concepts(name, norm, created_at) VALUES (?, ?, 1)');
const insCS = db.prepare('INSERT OR IGNORE INTO concept_sources(concept_id, source_id, chunk_id) VALUES (?, ?, NULL)');
const insE = db.prepare("INSERT OR IGNORE INTO concept_edges(a, b, label, source_id) VALUES (?, ?, 'r', ?)");
const concepts: number[] = [];
for (let i = 0; i < 2000; i++) {
  const id = Number(insConcept.run(`Konzept ${i}`, `konzept ${i}`).lastInsertRowid);
  concepts.push(id);
  for (let k = 0; k < 3; k++) insCS.run(id, sources[(i * 3 + k * 7) % sources.length]!);
}
for (let i = 1; i < 2000; i++) insE.run(concepts[Math.floor((i - 1) / 2)]!, concepts[i]!, sources[(i * 3) % sources.length]!);
for (let i = 0; i < 1000; i++) insE.run(concepts[(i * 7) % 2000]!, concepts[(i * 13 + 5) % 2000]!, sources[(i * 11) % sources.length]!);
db.exec('COMMIT');
db.exec('ANALYZE');
const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
console.log(`Testdaten in ${Math.round(performance.now() - t0)} ms: ${count('sources')} Quellen, ${count('chunks')} Abschnitte, ${count('cards')} Karten, ${count('reviews')} Wiederholungen, ${count('quiz_questions')} Fragen, ${count('quiz_attempts')} Antworten, ${count('concepts')} Konzepte, ${count('concept_edges')} Kanten`);

function measure(name: string, fn: () => unknown, runs = 7): void {
  fn(); // aufwärmen
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const a = performance.now();
    fn();
    ts.push(performance.now() - a);
  }
  ts.sort((x, y) => x - y);
  console.log(`${name.padEnd(48)} p50 ${ts[Math.floor(runs / 2)]!.toFixed(1).padStart(6)} ms   max ${ts[runs - 1]!.toFixed(1).padStart(6)} ms`);
}

const sub = subjects[3]!;
console.log('\nAbfrage (Median/Max von 7 Läufen, synchron = Event-Loop-Blockade):');
measure('Fällig-Liste (alle, 200)', () => data.dueCards(db, {}));
measure('Fällig-Liste (Fach)', () => data.dueCards(db, { subjectId: sub }));
measure('Statistik (alle)', () => data.srsStats(db));
measure('Statistik (Fach)', () => data.srsStats(db, sub));
measure('Kartenliste Entwürfe (500)', () => data.listCards(db, { status: 'draft', limit: 500 }));
measure('Kartenliste Suche "Frage 12"', () => data.listCards(db, { q: 'Frage 12', limit: 200 }));
measure('Karte wiederholen (Transaktion)', () => data.reviewCard(db, 1, 3));
measure('Graph alle (2000 Knoten)', () => data.graphData(db, {}));
measure('Graph Fach', () => data.graphData(db, { subjectId: sub }));
measure('Konzept-Details', () => data.conceptDetail(db, concepts[1]!));
measure('Schwächen-Analyse (alle)', () => data.weaknesses(db));
measure('Quiz-Runde starten (Fach, 20)', () => data.startSession(db, { mode: 'practice', scope: { subjectId: sub }, count: 20 }));
measure('Bereich laden: Fach (100 Quellen, max. 800)', () => loadScope(db, { kind: 'subject', id: sub }, 800));
measure('Bereich laden: Quelle', () => loadScope(db, { kind: 'source', id: sources[5]! }, 800));

const lib = new Library(db, new BlobStore(dir), new SqliteVectorStore(db), new EventBus());
const del: number[] = [];
for (let i = 0; i < 5; i++) {
  const a = performance.now();
  await lib.deleteSources([sources[100 + i]!]);
  del.push(performance.now() - a);
}
del.sort((x, y) => x - y);
console.log(`${'Quelle löschen inkl. Karten/Fragen/Cache/Graph'.padEnd(48)} p50 ${del[2]!.toFixed(1).padStart(6)} ms   max ${del[4]!.toFixed(1).padStart(6)} ms`);
console.log(`Integrität: ${(db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check}, FK-Verstöße: ${db.prepare('PRAGMA foreign_key_check').all().length}`);

const plan = (sql: string, ...p: (string | number)[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail).join(' | ');
console.log('\nEXPLAIN QUERY PLAN (Auszug):');
console.log('  Fällig-Liste:', plan("SELECT c.id FROM cards c WHERE c.status = 'active' AND (c.due IS NULL OR c.due <= ?) ORDER BY c.due IS NULL, c.due, c.id LIMIT 200", now));
console.log('  Fällig (Fach):', plan("SELECT c.id FROM cards c WHERE c.status = 'active' AND (c.due IS NULL OR c.due <= ?) AND c.subject_id = ?", now, sub));
console.log('  Heatmap:', plan("SELECT date(r.reviewed_at / 1000, 'unixepoch', 'localtime') AS day, count(*) FROM reviews r WHERE r.reviewed_at >= ? GROUP BY day", now));
console.log('  Graph-Knoten (Fach):', plan('SELECT c.id FROM concepts c JOIN concept_sources cs ON cs.concept_id = c.id WHERE cs.source_id IN (SELECT id FROM sources WHERE subject_id = ?) GROUP BY c.id', sub));
console.log('  Konzept-Kanten:', plan('SELECT e.id FROM concept_edges e WHERE e.a = ? OR e.b = ?', 1, 1));
console.log('  Schwächen:', plan('SELECT q.topic, avg(a.score) FROM quiz_attempts a JOIN quiz_questions q ON q.id = a.question_id GROUP BY q.topic, q.source_id'));
db.close();
fs.rmSync(dir, { recursive: true, force: true });
