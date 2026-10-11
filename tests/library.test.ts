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
    const children = (await app.api<{ id: number }[]>('GET', `/api/sources?parent=${up.data.source.id}`)).data;
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
