import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../server/db.ts';
import { SqliteVectorStore } from '../server/embed/vector-store.ts';
import { buildFtsQuery, rrfFuse, MARK_START, MARK_END } from '../server/search/hybrid.ts';
import { startTestApp, tmpDir, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';
import path from 'node:path';

describe('FTS-Query & RRF', () => {
  it('erzeugt sichere FTS5-Queries (keine Syntax-Injection) mit Präfix-Stemming', () => {
    expect(buildFtsQuery('Vektoren')).toBe('"vektoren" OR "vektor"*');
    expect(buildFtsQuery('   ')).toBeNull();
    const q = buildFtsQuery('foo" OR bar* NEAR(x) -y AND ^z :col')!;
    expect(q).not.toMatch(/NEAR\(|\^|:col/);
    expect(q.match(/"/g)!.length % 2).toBe(0);
  });

  it('RRF fusioniert Ranglisten (Treffer in beiden Listen gewinnen)', () => {
    const fused = rrfFuse([
      [1, 2, 3],
      [3, 4, 1],
    ]);
    expect(fused.map((f) => f.id).slice(0, 2)).toEqual([1, 3]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 63, 6);
    expect(fused.map((f) => f.id)).toEqual([1, 3, 2, 4]);
  });
});

describe('Vektorspeicher', () => {
  it('int8-Cache liefert (nahezu) dieselben Top-Treffer wie float32', () => {
    const dir = tmpDir('vec');
    const db = openDb(path.join(dir, 'v.sqlite'));
    db.prepare("INSERT INTO sources(id, sha256, name, size, mime, kind, status, imported_at) VALUES (1, 'x', 'x', 1, 'text/plain', 'text', 'ready', 0)").run();
    const dim = 256;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const ins = db.prepare("INSERT INTO chunks(id, source_id, ord, text, token_est) VALUES (?, 1, ?, 't', 1)");
    const items = [];
    for (let i = 1; i <= 3000; i++) {
      ins.run(i, i);
      items.push({ chunkId: i, sourceId: 1, vector: Float32Array.from({ length: dim }, rnd) });
    }
    const q8 = new SqliteVectorStore(db, { quantize: true });
    q8.setIndex('test', dim);
    q8.upsert(items);
    const f32 = new SqliteVectorStore(db, { quantize: false });
    let overlap = 0;
    for (let t = 0; t < 20; t++) {
      const query = Float32Array.from({ length: dim }, rnd);
      const a = new Set(q8.search(query, 10, null).map((h) => h.chunkId));
      const b = f32.search(query, 10, null).map((h) => h.chunkId);
      overlap += b.filter((id) => a.has(id)).length;
    }
    expect(overlap / 200).toBeGreaterThanOrEqual(0.9);
    expect(q8.memoryBytes()).toBeLessThan(f32.memoryBytes() / 3);
    // Filter auf erlaubte Quellen
    expect(q8.search(items[0]!.vector, 5, new Set([2]))).toHaveLength(0);
    db.close();
  });
});

describe('Hybrid-Suche (End-to-End)', () => {
  let app: TestApp;
  let mathe: number;
  let bio: number;
  beforeAll(async () => {
    app = await startTestApp();
    mathe = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Mathe', color: '#39e6ff' })).data.id;
    bio = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Bio', color: '#3dffa8' })).data.id;
    const docs: [string, string, number][] = [
      ['vektoren.md', '# Lineare Algebra\n\nEin Vektorraum enthält Vektoren, die man addieren und skalieren kann.', mathe],
      ['matrizen.md', '# Matrizen\n\nDie Determinante einer Matrix entscheidet über Invertierbarkeit.', mathe],
      ['zelle.md', '# Zellbiologie\n\nMitochondrien sind die Kraftwerke der Zelle und erzeugen ATP.', bio],
    ];
    for (const [name, text, subjectId] of docs) {
      const r = await app.upload(name, text, { subjectId });
      await waitForSource(app, r.data.source.id);
    }
    await waitForEmbeddings(app);
  });
  afterAll(async () => app.close());

  it('findet Treffer mit Quelle, Fach, Position und markiertem Snippet', async () => {
    const r = await app.api<{ hits: Record<string, unknown>[]; mode: string; tookMs: number }>('GET', '/api/search?q=Vektoren%20addieren');
    expect(r.data.mode).toBe('hybrid');
    const top = r.data.hits[0]!;
    expect(top).toMatchObject({ sourceName: 'vektoren.md', subjectName: 'Mathe', subjectColor: '#39e6ff', locKind: 'lines' });
    expect(top.matchedBy).toEqual(['fts', 'vector']);
    expect(String(top.snippet)).toContain(`${MARK_START}Vektoren${MARK_END}`);
  });

  it('Stemming-Präfix: "Determinanten" findet "Determinante"', async () => {
    const r = await app.api<{ hits: { sourceName: string }[] }>('GET', '/api/search?q=Determinanten');
    expect(r.data.hits[0]!.sourceName).toBe('matrizen.md');
  });

  it('Wissensbereich filtert nach Fächern und Quellen', async () => {
    const scope = encodeURIComponent(JSON.stringify({ mode: 'subjects', ids: [bio] }));
    const r = await app.api<{ hits: { subjectName: string }[] }>('GET', `/api/search?q=Matrix%20Zelle&scope=${scope}`);
    expect(r.data.hits.length).toBeGreaterThan(0);
    expect(r.data.hits.every((h) => h.subjectName === 'Bio')).toBe(true);
    const none = encodeURIComponent(JSON.stringify({ mode: 'none' }));
    expect((await app.api<{ hits: unknown[] }>('GET', `/api/search?q=Zelle&scope=${none}`)).data.hits).toHaveLength(0);
  });

  it('Sonderzeichen in der Suche verursachen keinen Fehler', async () => {
    for (const q of ['"', 'NEAR(', 'a AND OR', "'; DROP TABLE chunks; --", '***', 'ü*ß']) {
      expect((await app.api('GET', `/api/search?q=${encodeURIComponent(q)}`)).status, q).toBe(200);
    }
  });
});
