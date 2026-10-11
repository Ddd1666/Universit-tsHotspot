import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openZip, readZipParts, ZipSecurityError } from '../server/ingest/zip.ts';
import { makeZip, patchZipDeclaredSizes } from './fixtures.ts';
import { startTestApp, tmpDir, waitFor, waitForSource, writeTmp, type TestApp } from './helpers.ts';

const dir = tmpDir('zip');
const LIMITS = { maxEntries: 100, maxTotalBytes: 5 * 1024 * 1024, maxEntryBytes: 2 * 1024 * 1024, maxRatio: 1000 };

describe('ZIP-Sicherheit (Unit)', () => {
  it('lehnt Zip-Slip-Pfade (../, absolut, Backslash) ab', async () => {
    for (const evil of ['../../evil.txt', '/etc/evil.txt', '..\\..\\evil.txt', 'ok/../../evil.txt', 'C:/Windows/evil.txt']) {
      const p = writeTmp(dir, 'slip.zip', makeZip({ 'gut.txt': 'ok', [evil]: 'böse' }));
      await expect(openZip(p, LIMITS), evil).rejects.toMatchObject({ code: 'zip_unsafe_path' });
    }
  });

  it('erkennt Zip-Bomben über Gesamtgröße, Kompressionsrate und Anzahl', async () => {
    const zeros = new Uint8Array(12 * 1024 * 1024); // 12 MB Nullen -> wenige KB komprimiert
    const bomb = writeTmp(dir, 'bomb.zip', makeZip({ 'zeros.bin': zeros }, 9));
    expect(fs.statSync(bomb).size).toBeLessThan(100_000);
    await expect(openZip(bomb, LIMITS)).rejects.toBeInstanceOf(ZipSecurityError);
    await expect(openZip(bomb, { ...LIMITS, maxTotalBytes: 100 * 1024 * 1024 })).rejects.toMatchObject({ code: 'zip_bomb' }); // Ratio

    const many: Record<string, string> = {};
    for (let i = 0; i < 150; i++) many[`f${i}.txt`] = 'x';
    await expect(openZip(writeTmp(dir, 'many.zip', makeZip(many)), LIMITS)).rejects.toMatchObject({ code: 'zip_limits' });
  });

  it('zählt tatsächlich entpackte Bytes – lügende Header helfen nicht', async () => {
    const data = new Uint8Array(3 * 1024 * 1024).fill(65);
    const liar = writeTmp(dir, 'liar.zip', patchZipDeclaredSizes(makeZip({ 'a.txt': data }, 9), 1000));
    const zip = await openZip(liar, { ...LIMITS, maxRatio: 1e9 });
    const entry = zip.entries[0]!;
    expect(entry.size).toBe(1000); // Header behauptet 1000 Bytes
    const stream = await zip.openStream(entry, LIMITS.maxEntryBytes);
    await expect(
      (async () => {
        for await (const _ of stream) void _;
      })(),
    ).rejects.toBeTruthy();
    zip.close();
  });

  it('OOXML-Teile werden ebenfalls begrenzt gelesen', async () => {
    const p = writeTmp(dir, 'big.docx', makeZip({ 'word/document.xml': new Uint8Array(3 * 1024 * 1024).fill(32) }, 9));
    await expect(readZipParts(p, () => true, 1024 * 1024)).rejects.toBeInstanceOf(ZipSecurityError);
  });
});

describe('ZIP-Import (End-to-End)', () => {
  let app: TestApp;
  let appParent: string;
  beforeAll(async () => {
    // eigener Elternordner: prüft, dass beim Zip-Slip-Versuch daneben nichts entsteht
    appParent = tmpDir('zipapp');
    app = await startTestApp({ dataDir: path.join(appParent, 'data') });
  });
  afterAll(async () => app.close());

  it('entpackt sicher: Unterordner, versteckte Dateien, Duplikate, verschachtelte Archive', async () => {
    const subject = (await app.api<{ id: number }>('POST', '/api/subjects', { name: 'Physik', color: '#39e6ff' })).data;
    const inner = makeZip({ 'x.txt': 'innen' });
    const zip = makeZip({
      'skripte/kapitel1.md': '# Mechanik\n\nKraft ist Masse mal Beschleunigung.',
      'skripte/kopie.md': '# Mechanik\n\nKraft ist Masse mal Beschleunigung.', // Duplikat
      '__MACOSX/._kapitel1.md': 'meta',
      '.DS_Store': 'x',
      'bilder/foto.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
      'archiv/inner.zip': inner,
    });
    const r = await app.upload('paket.zip', zip, { subjectId: subject.id });
    expect(r.status).toBe(200);
    const parent = await waitForSource(app, r.data.source.id);
    expect(parent.status).toBe('archive');
    const summary = JSON.parse(parent.statusDetail!);
    expect(summary).toMatchObject({ files: 3, duplicates: 1, skipped: 2 });
    const children = (await app.api<{ items: { id: number; relPath: string; subjectId: number; status: string; statusDetail: string }[] }>('GET', `/api/sources?parent=${r.data.source.id}`)).data.items;
    expect(children.map((c) => c.relPath).sort()).toEqual(['archiv/inner.zip', 'bilder/foto.png', 'skripte/kapitel1.md']);
    expect(children.every((c) => c.subjectId === subject.id)).toBe(true);
    const md = children.find((c) => c.relPath.endsWith('.md'))!;
    expect((await waitForSource(app, md.id)).status).toBe('ready');
    expect(children.find((c) => c.relPath.endsWith('.png'))!.statusDetail).toBe('phase2_media');
    expect(children.find((c) => c.relPath.endsWith('.zip'))!.statusDetail).toBe('nested_archive');
  });

  it('Zip-Slip-Archiv wird abgelehnt, nichts landet außerhalb des Datenordners', async () => {
    const before = new Set(fs.readdirSync(appParent));
    const r = await app.upload('slip.zip', makeZip({ 'ok.txt': 'harmlos', '../../../pwned.txt': 'böse' }));
    const s = await waitForSource(app, r.data.source.id);
    expect(s.status).toBe('error');
    expect(s.statusDetail).toBe('zip_unsafe_path');
    const after = fs.readdirSync(appParent).filter((f) => !before.has(f));
    expect(after).toEqual([]);
    expect(fs.existsSync(path.join(app.dataDir, '..', 'pwned.txt'))).toBe(false);
  });

  it('Zip-Bombe wird als Fehler gemeldet, ohne Absturz', async () => {
    await app.api('PUT', '/api/settings', { zipMaxTotalMB: 5 });
    const r = await app.upload('bomb.zip', makeZip({ 'zeros.bin': new Uint8Array(20 * 1024 * 1024) }, 9));
    const s = await waitForSource(app, r.data.source.id);
    expect(s.status).toBe('error');
    expect((await app.api('GET', '/api/health')).status).toBe(200);
    await waitFor(async () => (await app.api<{ ok: boolean }>('GET', '/api/health')).data.ok);
  });
});
