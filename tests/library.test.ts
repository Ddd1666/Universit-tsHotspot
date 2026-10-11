import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeZip } from './fixtures.ts';
import { startTestApp, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => app.close());

function counts() {
  const db = app.hotspot.services.db;
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    sources: one('SELECT count(*) AS n FROM sources'),
    chunks: one('SELECT count(*) AS n FROM chunks'),
    fts: one("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'loeschtest OR archivinhalt'"),
    vectors: one('SELECT count(*) AS n FROM embeddings'),
  };
}

describe('Fächer', () => {
  it('anlegen, umbenennen, Farbe ändern, löschen (Quellen behalten oder mitlöschen)', async () => {
    const a = (await app.api<{ id: number; name: string }>('POST', '/api/subjects', { name: 'Analysis', color: '#39e6ff' })).data;
    expect(a.name).toBe('Analysis');
    const renamed = await app.api<{ name: string; color: string }>('PATCH', `/api/subjects/${a.id}`, { name: 'Analysis I', color: '#a77bff' });
    expect(renamed.data).toMatchObject({ name: 'Analysis I', color: '#a77bff' });
    expect((await app.api('POST', '/api/subjects', { name: 'x', color: 'rot' })).status).toBe(400);

    const up = await app.upload('ana.txt', 'Grenzwerte und Folgen', { subjectId: a.id });
    await waitForSource(app, up.data.source.id);
    const b = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Statistik', color: '#3dffa8' })).data;
    const moved = await app.api<{ subjectId: number }>('PATCH', `/api/sources/${up.data.source.id}`, { subjectId: b.id });
    expect(moved.data.subjectId).toBe(b.id);
    const subjects = (await app.api<{ id: number; sourceCount: number }[]>('GET', '/api/subjects')).data;
    expect(subjects.find((s) => s.id === b.id)!.sourceCount).toBe(1);

    // Fach löschen, Quellen behalten -> "Ohne Fach"
    await app.api('DELETE', `/api/subjects/${b.id}`);
    const src = (await app.api<{ source: { subjectId: number | null } }>('GET', `/api/sources/${up.data.source.id}`)).data.source;
    expect(src.subjectId).toBeNull();

    // Fach inkl. Quellen löschen
    const c = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Weg', color: '#ff4fd8' })).data;
    const up2 = await app.upload('weg.txt', 'wird mit dem Fach gelöscht', { subjectId: c.id });
    await waitForSource(app, up2.data.source.id);
    await app.api('DELETE', `/api/subjects/${c.id}?deleteSources=true`);
    expect((await app.api('GET', `/api/sources/${up2.data.source.id}`)).status).toBe(404);
  });
});

describe('Löschkonsistenz', () => {
  it('Quelle löschen entfernt Datei, Chunks, Volltext-Index und Vektoren', async () => {
    const before = counts();
    const up = await app.upload('loeschen.md', '# Löschtest\n\nloeschtest Inhalt mit eindeutigem Wort.');
    await waitForSource(app, up.data.source.id);
    await waitForEmbeddings(app);
    const mid = counts();
    expect(mid.chunks).toBeGreaterThan(before.chunks);
    expect(mid.fts).toBe(before.fts + 1);
    expect(mid.vectors).toBeGreaterThan(before.vectors);
    const sha = (await app.api<{ source: { sha256: string } }>('GET', `/api/sources/${up.data.source.id}`)).data.source.sha256;
    const file = app.hotspot.services.blobs.pathFor(sha);
    expect(fs.existsSync(file)).toBe(true);

    expect((await app.api('DELETE', `/api/sources/${up.data.source.id}`)).status).toBe(200);
    expect(counts()).toEqual(before);
    expect(fs.existsSync(file)).toBe(false);
    const search = await app.api<{ hits: { sourceId: number }[] }>('GET', '/api/search?q=loeschtest');
    expect(search.data.hits.filter((h) => h.sourceId === up.data.source.id)).toHaveLength(0);
  });

  it('Archiv löschen entfernt auch alle daraus importierten Dateien', async () => {
    const before = counts();
    const up = await app.upload('paket.zip', makeZip({ 'a.txt': 'archivinhalt eins', 'b/c.txt': 'archivinhalt zwei' }));
    await waitForSource(app, up.data.source.id);
    const children = (await app.api<{ items: { id: number }[] }>('GET', `/api/sources?parent=${up.data.source.id}`)).data.items;
    expect(children).toHaveLength(2);
    for (const c of children) await waitForSource(app, c.id);
    await waitForEmbeddings(app);
    const del = await app.api<{ removed: number }>('DELETE', `/api/sources/${up.data.source.id}`);
    expect(del.data.removed).toBe(3);
    expect(counts()).toEqual(before);
    for (const c of children) expect((await app.api('GET', `/api/sources/${c.id}`)).status).toBe(404);
  });

  it('Garbage-Collection entfernt verwaiste Dateien', async () => {
    const orphan = app.hotspot.services.blobs.pathFor('a'.repeat(64));
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'verwaist');
    expect(await app.hotspot.services.library.gcOrphanBlobs()).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});

describe('Bibliotheksliste skaliert linear', () => {
  it('2000+ Quellen mit 40k+ Chunks: Liste schnell, Kappung sichtbar, Index genutzt', async () => {
    const { db } = app.hotspot.services;
    db.exec('BEGIN');
    const s = db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, 1, 'text/plain', 'text', 'ready', ?, 20)");
    const c = db.prepare('INSERT INTO chunks(source_id, ord, text, token_est, embed_state) VALUES (?, ?, ?, 10, ?)');
    for (let i = 0; i < 2100; i++) {
      const id = Number(s.run(i.toString(16).padStart(63, '0') + 'b', `masse-${i}.txt`, 1000 + i).lastInsertRowid);
      for (let k = 0; k < 20; k++) c.run(id, k, `Massentext ${i} ${k}`, k % 3 ? 1 : 2); // 2 = nicht erneut einbetten
    }
    db.exec('COMMIT');
    const t0 = performance.now();
    const r = await app.api<{ items: { name: string; embeddedCount: number; chunkCount: number }[]; total: number; limit: number }>('GET', '/api/sources');
    const ms = performance.now() - t0;
    expect(r.data.items).toHaveLength(2000);
    expect(r.data.total).toBeGreaterThanOrEqual(2100);
    expect(r.data.limit).toBe(2000);
    expect(r.data.items.find((x) => x.name === 'masse-2099.txt')!.embeddedCount).toBe(13);
    expect(ms).toBeLessThan(1500); // vorher: ~8 s (Server blockiert)
    const plan = (db.prepare(
      'EXPLAIN QUERY PLAN SELECT count(*) FROM chunks c INDEXED BY chunks_source_state WHERE c.source_id = ? AND c.embed_state = 1',
    ).all(1) as { detail: string }[]).map((p) => p.detail).join(' ');
    expect(plan).toContain('chunks_source_state');
    db.exec("DELETE FROM chunks WHERE text LIKE 'Massentext%'");
    db.exec("DELETE FROM sources WHERE name LIKE 'masse-%'");
  });
});

describe('Vorschau rund um einen Ziel-Chunk ("In Bibliothek zeigen")', () => {
  it('liefert den Ziel-Chunk auch jenseits der ersten 40 Abschnitte', async () => {
    const md = Array.from({ length: 150 }, (_, i) => `# Teil ${i}\n\nInhalt von Teil ${i}. ${'Mehr Text. '.repeat(30)}`).join('\n\n');
    const up = await app.upload('lang.md', md);
    await waitForSource(app, up.data.source.id);
    const target = app.hotspot.services.db.prepare('SELECT id, ord FROM chunks WHERE source_id = ? ORDER BY ord DESC LIMIT 1').get(up.data.source.id) as { id: number; ord: number };
    expect(target.ord).toBeGreaterThan(40);
    const first = await app.api<{ chunks: { id: number }[] }>('GET', `/api/sources/${up.data.source.id}`);
    expect(first.data.chunks.some((c) => c.id === target.id)).toBe(false);
    const around = await app.api<{ chunks: { id: number }[] }>('GET', `/api/sources/${up.data.source.id}?around=${target.id}`);
    expect(around.data.chunks.some((c) => c.id === target.id)).toBe(true);
  });
});
