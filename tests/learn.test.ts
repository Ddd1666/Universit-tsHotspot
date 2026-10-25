import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, tmpDir, waitFor, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';
import { fakeEmbedding } from '../server/ollama/mock.ts';
import { normalize } from '../server/embed/vector-store.ts';
import type { LearnJobDTO } from '../server/learn/jobs.ts';
import { Scheduler } from '../server/scheduler.ts';

type Job = LearnJobDTO;

/** eindeutiges Kunstwort (nur Buchstaben) – macht Sätze für Duplikat-Erkennung unterscheidbar */
const word = (n: number) => 'w' + [...n.toString(26)].map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('') + 'ix';

/** Langer Text: jeder Absatz ein eigener Fakt (Satz ≥ 20 Zeichen) – deutlich größer als ein 8k-Kontext. */
function longText(n: number, tag = ''): string {
  return Array.from(
    { length: n },
    (_, i) => `Absatz ${i}: Der Begriff Thema${i}${tag} beschreibt die Eigenschaft Nummer ${i} der Thermodynamik. ${Array.from({ length: 40 }, (_, j) => `Erläuterung ${word(i * 40 + j)} betrifft ${word(i * 40 + j + 7777)} im Fachgebiet.`).join(' ')}`,
  ).join('\n\n');
}

async function job(app: TestApp, body: unknown): Promise<Job> {
  const r = await app.api<Job>('POST', '/api/learn/jobs', body);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}

async function waitJob(app: TestApp, id: number, states = ['done', 'error', 'cancelled']): Promise<Job> {
  return waitFor(() => {
    const j = app.hotspot.services.learn.get(id);
    return j && states.includes(j.state) ? j : null;
  }, { message: `learn job ${id}`, timeout: 40_000 });
}

const tasks = (app: TestApp, task: string) =>
  app.hotspot.mock!.requests.filter((r) => r.path === '/api/chat' && ((r.body as { messages?: { content: string }[] }).messages?.[0]?.content ?? '').startsWith(`TASK: ${task}`));

async function importText(app: TestApp, name: string, text: string, subjectId?: number): Promise<number> {
  const up = await app.upload(name, text, { subjectId });
  expect(up.status).toBe(200);
  const s = await waitForSource(app, up.data.source.id);
  expect(s.status).toBe('ready');
  return up.data.source.id;
}

describe('Lernmodi – Integration (Mock-Ollama)', () => {
  let app: TestApp;
  let subject: number;
  let src: number;
  let src2: number;

  beforeAll(async () => {
    app = await startTestApp();
    subject = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Physik', color: '#39e6ff' })).data.id;
    src = await importText(app, 'Thermo.txt', longText(60), subject);
    src2 = await importText(
      app,
      'Carnot.md',
      '# Kreisprozesse\n\nDie Carnot-Maschine ist ein idealisierter Kreisprozess zwischen zwei Wärmebädern.\n\nDie Entropie eines abgeschlossenen Systems nimmt niemals ab, sagt der Hauptsatz.\n\n## Fehler\n\nMOCKHALLU Dieser Absatz verleitet das Modell zu erfundenen Antworten über Dinge.',
      subject,
    );
    await waitForEmbeddings(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('Zusammenfassung einer Quelle > Kontext: Map-Reduce über mehrere Gruppen, zitiert, als bearbeitbare Notiz gespeichert', async () => {
    const before = tasks(app, 'summary-map').length;
    const j = await waitJob(app, (await job(app, { kind: 'summary', scope: { kind: 'source', id: src }, level: 'detailed' })).id);
    expect(j.state, j.detail ?? '').toBe('done');
    const maps = tasks(app, 'summary-map').length - before;
    expect(maps).toBeGreaterThanOrEqual(3); // Text passt nicht in einen Aufruf
    expect(tasks(app, 'summary-reduce').length).toBeGreaterThanOrEqual(1);
    // jeder Aufruf bleibt im Kontext (8192): grob 3 Zeichen/Token
    for (const r of tasks(app, 'summary-map')) expect(JSON.stringify((r.body as { messages: unknown }).messages).length / 3).toBeLessThan(8192);
    const note = (await app.api<{ body: string; citations: { n: number; sourceId: number; chunkId: number }[]; ai: boolean; level: string }>('GET', `/api/notes/${j.result!.noteId}`)).data;
    expect(note.ai).toBe(true);
    expect(note.level).toBe('detailed');
    expect(note.body).toMatch(/\[\d+\]/);
    expect(note.citations.length).toBeGreaterThan(5);
    expect(new Set(note.citations.map((c) => c.chunkId)).size).toBe(note.citations.length);
    expect(Math.max(...[...note.body.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))).toBeLessThanOrEqual(note.citations.length);
    // bearbeiten + Export
    const edited = await app.api<{ edited: boolean; body: string }>('PATCH', `/api/notes/${j.result!.noteId}`, { body: note.body + '\n\nEigene Ergänzung.' });
    expect(edited.data.edited).toBe(true);
    const md = (await app.api<{ name: string; markdown: string }>('GET', `/api/notes/${j.result!.noteId}/export`)).data;
    expect(md.markdown).toContain('KI-generiert');
    expect(md.markdown).toContain('Eigene Ergänzung.');
    expect(md.markdown).toContain('## Quellen');
    expect(md.name).toMatch(/\.md$/);
  });

  it('kleiner Kontext (num_ctx 2048): hierarchisches Reduce, alle Teile des Dokuments zitiert', async () => {
    await app.api('PUT', '/api/settings', { numCtx: 2048 });
    try {
      const reduceBefore = tasks(app, 'summary-reduce').length;
      const j = await waitJob(app, (await job(app, { kind: 'summary', scope: { kind: 'source', id: src }, level: 'outline' })).id);
      expect(j.state, j.detail ?? '').toBe('done');
      expect(tasks(app, 'summary-reduce').length - reduceBefore).toBeGreaterThan(2); // Zusammenführen in mehreren Runden
      const note = (await app.api<{ citations: { chunkId: number }[] }>('GET', `/api/notes/${j.result!.noteId}`)).data;
      const chunks = app.hotspot.services.db.prepare('SELECT id FROM chunks WHERE source_id = ? ORDER BY ord').all(src) as { id: number }[];
      const cited = new Set(note.citations.map((c) => c.chunkId));
      expect(cited.has(chunks[0]!.id) && cited.has(chunks.at(-1)!.id)).toBe(true);
    } finally {
      await app.api('PUT', '/api/settings', { numCtx: 8192 });
    }
  });

  it('Cache: zweiter Lauf ohne neue Map-Aufrufe; geänderte Quelle invalidiert nur die betroffene Gruppe', async () => {
    const before = tasks(app, 'summary-map').length;
    expect((await waitJob(app, (await job(app, { kind: 'summary', scope: { kind: 'source', id: src }, level: 'tldr' })).id)).state).toBe('done');
    expect(tasks(app, 'summary-map').length).toBe(before); // alles aus dem Cache (Stufe egal)
    const db = app.hotspot.services.db;
    const last = db.prepare('SELECT id FROM chunks WHERE source_id = ? ORDER BY ord DESC LIMIT 1').get(src) as { id: number };
    db.prepare("UPDATE chunks SET text = text || ' Geändert.' WHERE id = ?").run(last.id);
    expect((await waitJob(app, (await job(app, { kind: 'summary', scope: { kind: 'source', id: src }, level: 'tldr' })).id)).state).toBe('done');
    expect(tasks(app, 'summary-map').length).toBe(before + 1);
    // anderes Chat-Modell: Zwischenergebnisse des alten Modells werden NICHT wiederverwendet
    await app.api('PUT', '/api/settings', { chatModel: 'llama3.1:8b' });
    try {
      const j = await waitJob(app, (await job(app, { kind: 'summary', scope: { kind: 'source', id: src }, level: 'tldr' })).id);
      expect(tasks(app, 'summary-map').length).toBe(before + 1 + (j.total! - 1));
    } finally {
      await app.api('PUT', '/api/settings', { chatModel: 'gemma3:4b' });
    }
  });

  it('Karten: Entwürfe mit Quellenverweis, Plausibilitätsprüfung, Dedupe; annehmen → lernen → SM-2-Zeitplan; Verlauf bleibt bei Edit', async () => {
    const scope = { kind: 'sources', ids: [src2, src] };
    const j = await waitJob(app, (await job(app, { kind: 'cards', scope, count: 10 })).id);
    expect(j.state, j.detail ?? '').toBe('done');
    expect(j.result!.rejected).toBeGreaterThan(0); // MOCKHALLU-Karte verworfen
    const drafts = (await app.api<{ items: { id: number; status: string; ai: boolean; sourceId: number; chunkId: number; back: string; front: string; type: string }[] }>('GET', `/api/cards?status=draft&job=${j.id}`)).data.items;
    expect(drafts.length).toBe(j.result!.created);
    expect(drafts.length).toBeGreaterThan(3);
    expect(drafts.every((c) => c.ai && [src, src2].includes(c.sourceId) && c.chunkId)).toBe(true);
    expect(drafts.some((c) => c.type === 'cloze' && /\{\{.+\}\}/.test(c.front))).toBe(true);
    expect(drafts.some((c) => /Quantengravitation/.test(c.back))).toBe(false);
    // nichts landet ungeprüft im Stapel
    expect((await app.api<{ items: unknown[] }>('GET', '/api/srs/due')).data.items).toHaveLength(0);
    // gleicher Auftrag erneut: bereits vorhandene Karten werden als Duplikat erkannt (Fingerabdruck/Embedding gegen Bestand),
    // es kommen nur weitere, neue Kandidaten dazu
    const j2 = await waitJob(app, (await job(app, { kind: 'cards', scope, count: 10 })).id);
    expect(j2.result!.duplicates).toBeGreaterThan(0);
    const second = (await app.api<{ items: { front: string; back: string }[] }>('GET', `/api/cards?job=${j2.id}`)).data.items;
    const firstKeys = new Set(drafts.map((c) => c.front + '|' + c.back));
    expect(second.every((c) => !firstKeys.has(c.front + '|' + c.back))).toBe(true);
    await app.api('POST', '/api/cards/bulk', { ids: (await app.api<{ items: { id: number }[] }>('GET', `/api/cards?job=${j2.id}`)).data.items.map((c) => c.id), action: 'discard' });
    // annehmen / verwerfen
    const [keep, drop, ...rest] = drafts;
    expect((await app.api<{ changed: number }>('POST', '/api/cards/bulk', { ids: [keep!.id, ...rest.map((c) => c.id)], action: 'accept' })).data.changed).toBe(drafts.length - 1);
    expect((await app.api<{ changed: number }>('POST', '/api/cards/bulk', { ids: [drop!.id], action: 'discard' })).data.changed).toBe(1);
    const due = (await app.api<{ items: { id: number }[]; fresh: number }>('GET', `/api/srs/due?subject=${subject}`)).data;
    expect(due.fresh).toBe(drafts.length - 1);
    const t0 = Date.now();
    const r1 = (await app.api<{ due: number; intervalDays: number; reps: number }>('POST', `/api/cards/${keep!.id}/review`, { rating: 3 })).data;
    expect([r1.reps, r1.intervalDays]).toEqual([1, 1]);
    expect(r1.due - t0).toBeGreaterThan(23 * 3600_000);
    const r2 = (await app.api<{ intervalDays: number; reviewCount: number }>('POST', `/api/cards/${keep!.id}/review`, { rating: 3 })).data;
    expect([r2.intervalDays, r2.reviewCount]).toEqual([6, 2]);
    // Bearbeiten ändert Text, nicht Zeitplan/Verlauf
    const e = (await app.api<{ front: string; reviewCount: number; intervalDays: number; reps: number }>('PATCH', `/api/cards/${keep!.id}`, { front: 'Neue Frage?', back: 'Neue Antwort' })).data;
    expect([e.front, e.reviewCount, e.intervalDays, e.reps]).toEqual(['Neue Frage?', 2, 6, 2]);
    // Statistik
    const st = (await app.api<{ heatmap: { n: number }[]; forecast: { n: number }[]; retention: { total: number; rate: number }; counts: { active: number } }>('GET', `/api/srs/stats?subject=${subject}`)).data;
    expect(st.heatmap.reduce((n, d) => n + d.n, 0)).toBe(2);
    expect(st.retention.rate).toBe(1);
    expect(st.forecast.reduce((n, d) => n + d.n, 0)).toBe(1);
    expect(st.counts.active).toBe(drafts.length - 1);
  });

  it('manuelle Karten: Frage/Antwort, Lückentext (braucht {{…}}), Bild (braucht Bild-Quelle); Fehlercodes', async () => {
    expect((await app.api('POST', '/api/cards', { type: 'qa', front: 'Was ist Entropie?', back: 'Maß für Unordnung', subjectId: subject })).status).toBe(200);
    expect((await app.api<{ error: string }>('POST', '/api/cards', { type: 'cloze', front: 'ohne Lücke' })).data.error).toBe('card_cloze_missing');
    expect((await app.api<{ error: string }>('POST', '/api/cards', { type: 'image', front: 'Was zeigt das Bild?', back: 'x', sourceId: src })).data.error).toBe('card_image_missing');
    expect((await app.api<{ error: string }>('POST', '/api/cards', { type: 'qa', front: 'F', back: '' })).data.error).toBe('card_invalid');
  });

  it('ungültige Ausgabe: begrenzte Wiederholungen (3), dann Fehlercode', async () => {
    const id = await importText(app, 'Kaputt.md', 'MOCKBADJSON Dieser Text bringt das Modell dazu, kein gültiges JSON zu liefern.', subject);
    const before = tasks(app, 'cards').length;
    const j = await waitJob(app, (await job(app, { kind: 'cards', scope: { kind: 'source', id }, count: 5 })).id);
    expect([j.state, j.detail]).toEqual(['error', 'learn_invalid_output']);
    expect(tasks(app, 'cards').length - before).toBe(3);
    await app.api('DELETE', `/api/sources/${id}`);
  });

  it('Quiz: Pool erzeugen (dedupliziert), Runde mit MC/WF/Lücke/Freitext, Freitext gegen Quellen bewertet, Lösung mit Quelle, Schwächen-Analyse', async () => {
    const j = await waitJob(app, (await job(app, { kind: 'quiz', scope: { kind: 'subject', id: subject }, count: 12 })).id);
    expect(j.state, j.detail ?? '').toBe('done');
    expect(j.result!.created).toBeGreaterThan(3);
    expect((await app.api<{ count: number }>('POST', '/api/quiz/pool', { scope: { subjectId: subject } })).data.count).toBe(j.result!.created);
    // erneut erzeugen: vorhandene Fragen werden erkannt (Pool wächst nur um neue)
    const again = await waitJob(app, (await job(app, { kind: 'quiz', scope: { kind: 'subject', id: subject }, count: 12 })).id);
    expect(again.result!.duplicates).toBeGreaterThan(0);
    const pool = (await app.api<{ count: number }>('POST', '/api/quiz/pool', { scope: { subjectId: subject } })).data.count;
    expect(pool).toBe(j.result!.created + again.result!.created);
    const texts = (app.hotspot.services.db.prepare('SELECT question FROM quiz_questions').all() as { question: string }[]).map((q) => q.question);
    expect(new Set(texts).size).toBe(texts.length);
    const s = (await app.api<{ session: { id: number }; questions: { id: number; type: string; options: string[] | null; answer?: string }[] }>('POST', '/api/quiz/sessions', { mode: 'practice', scope: { subjectId: subject }, count: 40 })).data;
    expect(s.questions.length).toBe(pool);
    expect(s.questions.every((q) => q.answer === undefined)).toBe(true); // Lösung erst nach der Antwort
    const types = new Set(s.questions.map((q) => q.type));
    expect(types.size).toBeGreaterThanOrEqual(3);
    for (const q of s.questions) {
      const r = (await app.api<{ score: number; answer: string; source: { sourceId: number; sourceName: string }; feedback: { rubric: unknown[]; quotes: { text: string }[]; refs: unknown[] } | null }>('POST', `/api/quiz/questions/${q.id}/answer`, {
        answer: q.type === 'mc' ? 'keine der Optionen' : q.type === 'tf' ? 'false' : 'völlig falsch',
        sessionId: s.session.id,
      })).data;
      expect(r.source.sourceName).toBeTruthy(); // Lösung immer mit Quelle
      expect(r.answer).toBeTruthy();
      if (q.type === 'short') {
        expect(r.feedback!.rubric.length).toBeGreaterThan(0);
        expect(r.feedback!.quotes.every((x) => !x.text.includes('nirgends'))).toBe(true); // erfundenes Zitat verworfen
        expect(r.score).toBeLessThan(0.5);
      } else expect(r.score).toBe(0);
    }
    // richtige Freitext-Antwort -> hohe Punktzahl
    const short = s.questions.find((q) => q.type === 'short');
    if (short) {
      const right = (await app.api<{ answer: string }>('POST', `/api/quiz/questions/${short.id}/answer`, { answer: 'x' })).data.answer;
      expect((await app.api<{ score: number }>('POST', `/api/quiz/questions/${short.id}/answer`, { answer: right })).data.score).toBeGreaterThanOrEqual(0.8);
    }
    const fin = (await app.api<{ total: number; answered: number }>('POST', `/api/quiz/sessions/${s.session.id}/finish`)).data;
    expect(fin.answered).toBe(pool);
    const weak = (await app.api<{ topic: string; avg: number; sourceId: number }[]>('GET', `/api/quiz/weak?subject=${subject}`)).data;
    expect(weak.length).toBeGreaterThan(0);
    expect(weak[0]!.avg).toBeLessThan(0.7);
    const hist = (await app.api<{ id: number }[]>('GET', '/api/quiz/history')).data;
    expect(hist[0]!.id).toBe(s.session.id);
    // Klausursimulation mit Zeitlimit
    const ex = (await app.api<{ session: { mode: string; timeLimitSec: number } }>('POST', '/api/quiz/sessions', { mode: 'exam', scope: { subjectId: subject }, count: 3, timeLimitSec: 120 })).data;
    expect([ex.session.mode, ex.session.timeLimitSec]).toEqual(['exam', 120]);
  });

  it('Wissensgraph: Konzepte je Quelle, Duplikate per Name + Embedding zusammengeführt, Details mit Abschnitten, korrigieren/ausblenden', async () => {
    const db = app.hotspot.services.db;
    // vorhandenes Konzept mit anderem Namen, aber gleichem Embedding -> "Kreisprozess" soll darauf abgebildet werden
    const ext = await importText(app, 'Extern.md', 'Ein externer Text über Kreisprozesse mit ausreichend Inhalt.');
    const v = normalize(Float32Array.from(fakeEmbedding('search_document: Kreisprozesse', 768)));
    const pre = Number(db.prepare("INSERT INTO concepts(name, norm, vec, created_at) VALUES ('Kreisprozess (Thermo)', 'kreisprozess thermo', ?, 1)").run(new Uint8Array(v.buffer)).lastInsertRowid);
    db.prepare('INSERT INTO concept_sources(concept_id, source_id) VALUES (?, ?)').run(pre, ext);
    const j = await waitJob(app, (await job(app, { kind: 'graph', scope: { kind: 'subject', id: subject } })).id);
    expect(j.state, j.detail ?? '').toBe('done');
    const g = (await app.api<{ nodes: { id: number; name: string; sources: number }[]; edges: { id: number; a: number; b: number; label: string }[]; total: number }>('GET', `/api/graph?subject=${subject}`)).data;
    expect(g.nodes.length).toBeGreaterThan(3);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.nodes.filter((n) => /^kreisprozess/i.test(n.name))).toHaveLength(1);
    // "Kreisprozess" aus Carnot.md per Embedding auf das vorhandene Konzept abgebildet
    expect((await app.api<{ sources: { sourceId: number }[] }>('GET', `/api/graph/concepts/${pre}`)).data.sources.map((x) => x.sourceId).sort()).toEqual([src2, ext].sort());
    const names = g.nodes.map((n) => n.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const d = (await app.api<{ sources: { sourceId: number; chunkId: number; snippet: string }[]; neighbors: unknown[] }>('GET', `/api/graph/concepts/${g.nodes[0]!.id}`)).data;
    expect(d.sources[0]!.snippet).toBeTruthy();
    // korrigieren: umbenennen behält den normalisierten Namen, ausblenden filtert
    await app.api('PATCH', `/api/graph/concepts/${g.nodes[0]!.id}`, { name: 'Umbenannt', hidden: true });
    const g2 = (await app.api<{ nodes: { id: number }[] }>('GET', `/api/graph?subject=${subject}`)).data;
    expect(g2.nodes.some((n) => n.id === g.nodes[0]!.id)).toBe(false);
    expect((await app.api<{ nodes: { id: number; name: string }[] }>('GET', `/api/graph?subject=${subject}&hidden=true`)).data.nodes.find((n) => n.id === g.nodes[0]!.id)!.name).toBe('Umbenannt');
    await app.api('PATCH', `/api/graph/edges/${g.edges[0]!.id}`, { label: 'korrigiert', hidden: false });
    // erneuter Lauf: Nutzerkorrektur (Name, ausgeblendet) bleibt erhalten
    await waitJob(app, (await job(app, { kind: 'graph', scope: { kind: 'subject', id: subject } })).id);
    const c = db.prepare('SELECT name, hidden FROM concepts WHERE id = ?').get(g.nodes[0]!.id) as { name: string; hidden: number };
    expect(c).toEqual({ name: 'Umbenannt', hidden: 1 });
  });

  it('Ansicht bleibt flüssig: höchstens 2000 Knoten (am stärksten vernetzte), Abfrage schnell', async () => {
    const db = app.hotspot.services.db;
    const many = await importText(app, 'Viele.md', 'Ein Text mit genug Inhalt für einen Abschnitt.', subject);
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO concepts(name, norm, created_at) VALUES (?, ?, 1)');
    const link = db.prepare('INSERT INTO concept_sources(concept_id, source_id) VALUES (?, ?)');
    const edge = db.prepare("INSERT INTO concept_edges(a, b, label, source_id) VALUES (?, ?, 'r', ?)");
    let prev = 0;
    for (let i = 0; i < 2600; i++) {
      const id = Number(ins.run(`K${i}`, `k${i} x`).lastInsertRowid);
      link.run(id, many);
      if (prev) edge.run(prev, id, many);
      prev = id;
    }
    db.exec('COMMIT');
    const t0 = performance.now();
    const g = (await app.api<{ nodes: unknown[]; total: number; truncated: boolean }>('GET', `/api/graph?source=${many}`)).data;
    const ms = performance.now() - t0;
    expect([g.nodes.length, g.total, g.truncated]).toEqual([2000, 2600, true]);
    expect(ms).toBeLessThan(5000); // Obergrenze, kein Zeit-Assert im engeren Sinn
    await app.api('DELETE', `/api/sources/${many}`);
    expect((db.prepare("SELECT count(*) AS n FROM concepts WHERE name LIKE 'K%' AND norm LIKE 'k% x'").get() as { n: number }).n).toBe(0);
  });

  it('Sicherheit: Token Pflicht, SQL-Sonderzeichen im Filter harmlos, ungültiger Bereich -> Code', async () => {
    const res = await fetch(app.url + '/api/cards');
    expect(res.status).toBe(401);
    const r = await app.api<{ items: unknown[] }>('GET', `/api/cards?q=${encodeURIComponent("%' OR 1=1 --")}`);
    expect([r.status, r.data.items.length]).toEqual([200, 0]);
    expect((await app.api<{ error: string }>('POST', '/api/learn/jobs', { kind: 'cards', scope: { kind: 'source', id: 'x' } })).data.error).toBe('learn_invalid_scope');
    expect((await app.api<{ error: string }>('POST', '/api/learn/jobs', { kind: 'graph', scope: { kind: 'chat', id: 1 } })).data.error).toBe('learn_invalid_scope');
    expect((await app.api('POST', '/api/learn/jobs', { kind: 'cards', scope: { kind: 'source', id: 999999 } })).status).toBe(404);
  });

  it('EXPLAIN QUERY PLAN: neue Abfragen nutzen Indizes (kein Vollscan der großen Tabellen)', () => {
    const db = app.hotspot.services.db;
    const plan = (sql: string, ...p: (string | number)[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan("SELECT id FROM cards c WHERE c.status = 'active' AND (c.due IS NULL OR c.due <= ?)", 1)).toMatch(/USING (COVERING )?INDEX cards_due/);
    expect(plan('SELECT id FROM cards c WHERE c.subject_id = ? AND c.status = ?', 1, 'active')).toMatch(/USING (COVERING )?INDEX cards_subject/);
    expect(plan('SELECT count(*) FROM reviews r WHERE r.reviewed_at >= ?', 1)).toMatch(/USING (COVERING )?INDEX reviews_time/);
    expect(plan('SELECT * FROM concept_sources WHERE source_id = ?', 1)).toMatch(/concept_sources_source/);
    expect(plan('SELECT * FROM learn_cache WHERE key = ?', 'x')).toMatch(/USING INDEX sqlite_autoindex_learn_cache/);
    expect(plan('SELECT * FROM cards WHERE chunk_id = ?', 1)).toMatch(/cards_chunk/);
  });
});

describe('Lernmodi – Löschkonsistenz, Neustart, Fehlerinjektion, Priorität', () => {
  it('Quelle löschen: Karten/Fragen behalten Text ohne Link (Hinweis), Notiz-Verweis "gelöscht", Cache + Graph-Bezüge weg, Integrität ok', async () => {
    const app = await startTestApp();
    try {
      const a = await importText(app, 'A.md', '# A\n\nDie Entropie eines abgeschlossenen Systems nimmt niemals ab, sagt der Hauptsatz.\n\nDie Carnot-Maschine arbeitet zwischen Wärmebädern.');
      const b = await importText(app, 'B.md', '# B\n\nDie Entropie wächst bei irreversiblen Prozessen in der Natur stetig an.');
      for (const kind of ['cards', 'quiz', 'summary', 'graph']) expect((await waitJob(app, (await job(app, { kind, scope: { kind: 'sources', ids: [a, b] } })).id)).state).toBe('done');
      const db = app.hotspot.services.db;
      const count = (sql: string, ...p: number[]) => (db.prepare(sql).get(...p) as { n: number }).n;
      const cardsA = count('SELECT count(*) AS n FROM cards WHERE source_id = ?', a);
      expect(cardsA).toBeGreaterThan(0);
      expect(count('SELECT count(*) AS n FROM learn_cache WHERE source_id = ?', a)).toBeGreaterThan(0);
      const onlyA = (db.prepare('SELECT concept_id AS id FROM concept_sources WHERE source_id = ? AND concept_id NOT IN (SELECT concept_id FROM concept_sources WHERE source_id = ?)').all(a, b) as { id: number }[]).map((r) => r.id);
      const shared = (db.prepare('SELECT concept_id AS id FROM concept_sources WHERE source_id = ? AND concept_id IN (SELECT concept_id FROM concept_sources WHERE source_id = ?)').all(a, b) as { id: number }[]).map((r) => r.id);
      expect(onlyA.length).toBeGreaterThan(0);
      expect(shared.length).toBeGreaterThan(0); // "Entropie" kommt in beiden vor
      const noteId = (db.prepare('SELECT id FROM notes ORDER BY id DESC LIMIT 1').get() as { id: number }).id;

      expect((await app.api('DELETE', `/api/sources/${a}`)).status).toBe(200);

      const cards = (await app.api<{ items: { sourceId: number | null; sourceDeleted: boolean; sourceName: string; front: string }[] }>('GET', '/api/cards?limit=500')).data.items;
      const orphaned = cards.filter((c) => c.sourceDeleted);
      expect(orphaned.length).toBe(cardsA);
      expect(orphaned.every((c) => c.sourceId === null && c.sourceName === 'A.md' && c.front)).toBe(true);
      expect(count("SELECT count(*) AS n FROM quiz_questions WHERE source_id IS NULL AND source_name = 'A.md'")).toBeGreaterThan(0);
      const note = (await app.api<{ citations: { sourceName: string; deleted: boolean }[]; body: string }>('GET', `/api/notes/${noteId}`)).data;
      expect(note.citations.filter((c) => c.sourceName === 'A.md').every((c) => c.deleted)).toBe(true);
      expect(note.citations.filter((c) => c.sourceName === 'B.md').every((c) => !c.deleted)).toBe(true);
      expect(count('SELECT count(*) AS n FROM learn_cache WHERE source_id = ?', a)).toBe(0);
      expect(count('SELECT count(*) AS n FROM concept_sources WHERE source_id = ?', a)).toBe(0);
      expect(count('SELECT count(*) AS n FROM concept_edges WHERE source_id = ?', a)).toBe(0);
      expect(count(`SELECT count(*) AS n FROM concepts WHERE id IN (SELECT value FROM json_each('${JSON.stringify(onlyA)}'))`)).toBe(0);
      expect(count(`SELECT count(*) AS n FROM concepts WHERE id IN (SELECT value FROM json_each('${JSON.stringify(shared)}'))`)).toBe(shared.length);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      // Export markiert den gelöschten Verweis
      expect((await app.api<{ markdown: string }>('GET', `/api/notes/${noteId}/export`)).data.markdown).toContain('(Quelle gelöscht)');
    } finally {
      await app.close();
    }
  });

  it('Fehlerinjektion im letzten Schreibschritt: nichts halb geschrieben (Rollback); erneuter Versuch nutzt den Cache', async () => {
    let fail = true;
    const app = await startTestApp({ learnFailBeforeCommit: () => {
      if (fail) throw new Error('simulierter Absturz');
    } });
    try {
      const a = await importText(app, 'A.md', '# A\n\nDie Entropie eines abgeschlossenen Systems nimmt niemals ab, sagt der Hauptsatz.');
      const j = await waitJob(app, (await job(app, { kind: 'cards', scope: { kind: 'source', id: a } })).id);
      expect([j.state, j.detail]).toEqual(['error', 'learn_failed']);
      const db = app.hotspot.services.db;
      expect((db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(0);
      const calls = tasks(app, 'cards').length;
      fail = false;
      expect((await app.api('POST', `/api/learn/jobs/${j.id}/retry`)).status).toBe(200);
      const j2 = await waitJob(app, j.id);
      expect(j2.state).toBe('done');
      expect(tasks(app, 'cards').length).toBe(calls); // Zwischenergebnis aus dem Cache
      expect((db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n).toBe(j2.result!.created);
    } finally {
      await app.close();
    }
  });

  it('Neustart mitten im Job: Job läuft weiter und überspringt fertige Schritte; "running" nach Absturz wird neu eingereiht', async () => {
    const dir = tmpDir('learn-restart');
    let app = await startTestApp({ dataDir: dir });
    let jobId: number;
    let doneFirst: number;
    let groups: number;
    try {
      const id = await importText(app, 'Lang.txt', longText(30, ' __MOCK_SLOW_LEARN__'));
      jobId = (await job(app, { kind: 'summary', scope: { kind: 'source', id }, level: 'tldr' })).id;
      await waitFor(() => (app.hotspot.services.learn.get(jobId)!.progress >= 1 ? true : null), { timeout: 20_000 });
      groups = app.hotspot.services.learn.get(jobId)!.total! - 1;
      expect(groups).toBeGreaterThan(1);
    } finally {
      await app.close(); // reguläres Beenden: Job -> wartend
    }
    {
      const { openDb } = await import('../server/db.ts');
      const db = openDb(`${dir}/hotspot.sqlite`);
      const row = db.prepare('SELECT state FROM learn_jobs WHERE id = ?').get(jobId) as { state: string };
      doneFirst = (db.prepare('SELECT count(*) AS n FROM learn_cache').get() as { n: number }).n;
      expect(row.state).toBe('queued');
      db.prepare("UPDATE learn_jobs SET state = 'running' WHERE id = ?").run(jobId); // wie nach kill -9
      db.close();
    }
    app = await startTestApp({ dataDir: dir });
    try {
      const j = await waitJob(app, jobId);
      expect(j.state, j.detail ?? '').toBe('done');
      expect(tasks(app, 'summary-map').length).toBe(groups - doneFirst);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('Chat hat Vorrang: laufender Lernaufruf wird unterbrochen und danach wiederholt; Job wird trotzdem fertig', async () => {
    const app = await startTestApp();
    try {
      const id = await importText(app, 'Lang.txt', longText(8));
      await waitForEmbeddings(app);
      app.hotspot.mock!.setLearnDelay(60_000); // Lernaufruf hängt, bis der Chat ihn unterbricht
      const j0 = await job(app, { kind: 'summary', scope: { kind: 'source', id }, level: 'tldr' });
      await waitFor(() => (tasks(app, 'summary-map').length >= 1 ? true : null));
      const chat = (await app.api<{ id: number }>('POST', '/api/chats', {})).data;
      const events = await app.stream(`/api/chats/${chat.id}/messages`, { content: 'Was ist Thermodynamik?' });
      expect(events.some((e) => e.event === 'done')).toBe(true);
      app.hotspot.mock!.setLearnDelay(0);
      const j = await waitJob(app, j0.id);
      expect(j.state).toBe('done');
      const groups = j.total! - 1;
      expect(tasks(app, 'summary-map').length).toBe(groups + 1); // der unterbrochene Aufruf wurde wiederholt
    } finally {
      await app.close();
    }
  }, 60_000);

  it('Abbrechen eines laufenden Jobs; Löschen der einzigen Quelle bricht ihren Job ab', async () => {
    const app = await startTestApp();
    try {
      const id = await importText(app, 'Lang.txt', longText(20, ' __MOCK_SLOW_LEARN__'));
      const j = await job(app, { kind: 'summary', scope: { kind: 'source', id } });
      await waitFor(() => (app.hotspot.services.learn.get(j.id)!.state === 'running' ? true : null));
      expect((await app.api('POST', `/api/learn/jobs/${j.id}/cancel`)).status).toBe(200);
      expect((await waitJob(app, j.id)).state).toBe('cancelled');
      const j2 = await job(app, { kind: 'summary', scope: { kind: 'source', id } });
      await waitFor(() => (app.hotspot.services.learn.get(j2.id)!.state === 'running' ? true : null));
      await app.api('DELETE', `/api/sources/${id}`);
      expect((await waitJob(app, j2.id)).state).toBe('cancelled');
      expect((app.hotspot.services.db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(0);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('Lernmodi – wartender Job, dessen Quelle gelöscht wurde', () => {
  it('meldet "learn_scope_missing" statt eines allgemeinen Fehlers', async () => {
    const app = await startTestApp();
    try {
      const a = await importText(app, 'A.txt', longText(4));
      const b = await importText(app, 'B.txt', longText(4, 'b'));
      app.hotspot.mock!.setLearnDelay(60_000);
      const first = await job(app, { kind: 'summary', scope: { kind: 'source', id: a } });
      const second = await job(app, { kind: 'cards', scope: { kind: 'source', id: b } });
      await waitFor(() => (tasks(app, 'summary-map').length ? true : null));
      expect(app.hotspot.services.learn.get(second.id)!.state).toBe('queued');
      await app.api('DELETE', `/api/sources/${b}`);
      app.hotspot.mock!.setLearnDelay(0);
      await app.api('POST', `/api/learn/jobs/${first.id}/cancel`);
      const j = await waitJob(app, second.id);
      expect([j.state, j.detail]).toEqual(['error', 'learn_scope_missing']);
    } finally {
      await app.close();
    }
  }, 60_000);
});

describe('Scheduler: Lern-Generierung hat die niedrigste Priorität', () => {
  it('wartende Slots: Embedding > Medien > Lernen; Chat-Start löst chatSignal aus', async () => {
    const s = new Scheduler();
    const order: string[] = [];
    const first = await s.acquire('media');
    const p = (['learn', 'media', 'embed'] as const).map((c) => s.acquire(c).then((rel) => (order.push(c), rel)));
    expect(s.snapshot().waiting).toEqual({ embed: 1, media: 1, learn: 1 });
    const sig = s.chatSignal();
    const end = s.chatStarted();
    expect(sig.aborted).toBe(true);
    expect(s.chatSignal().aborted).toBe(false);
    first();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]); // während des Chats kein neuer Slot
    end();
    (await p[2]!)();
    (await p[1]!)();
    (await p[0]!)();
    expect(order).toEqual(['embed', 'media', 'learn']);
  });
});
