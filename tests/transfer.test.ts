import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { zipSync, strToU8 } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { importLibrary, ZipWriter } from '../server/transfer.ts';
import { openZip } from '../server/ingest/zip.ts';
import { csvCell } from '../server/http/maintenance.ts';
import { makeZip } from './fixtures.ts';
import { startTestApp, tmpDir, waitFor, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';

const open: TestApp[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close().catch(() => {});
});
async function app(extra: Parameters<typeof startTestApp>[0] = {}) {
  const a = await startTestApp(extra);
  open.push(a);
  return a;
}
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
type Report = {
  subjects: { created: number; merged: number };
  sources: { added: number; duplicate: number; skipped: number; requeued: number };
  files: { added: number; existing: number; invalid: number };
  chunks: number;
  notes: { added: number; duplicate: number };
  cards: { added: number; duplicate: number };
  questions: { added: number; duplicate: number };
  skippedRecords: number;
};

async function importFile(a: TestApp, data: Buffer) {
  const r = await fetch(`${a.url}/api/library/import`, { method: 'POST', headers: { 'x-hotspot-token': a.token, 'content-type': 'application/octet-stream' }, body: new Uint8Array(data) });
  return { status: r.status, data: (await r.json()) as Report & { error?: string; detail?: string } };
}
async function exportFile(a: TestApp, subject: number | 'all') {
  const r = await fetch(`${a.url}/api/library/export?subject=${subject}&t=${a.token}`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="Uni-Hotspot-Export-/);
  return Buffer.from(await r.arrayBuffer());
}
const manifest = (v = 1) => JSON.stringify({ format: 'uni-hotspot-export', formatVersion: v });

describe('ZIP-Writer (unkomprimiert, streamend)', () => {
  it.each([undefined, 10])('Roundtrip über den eigenen ZIP-Leser, CRC stimmt (ZIP64-Schwelle %s)', async (threshold) => {
    const dir = tmpDir('zipw');
    const file = path.join(dir, 'out.zip');
    const big = crypto.randomBytes(200_000);
    const entries: [string, Buffer][] = [
      ['manifest.json', Buffer.from('{"a":1}')],
      ['files/' + sha(big), big],
      ['leer.txt', Buffer.alloc(0)],
      ['ümlaut/ä.txt', Buffer.from('Grüße')],
    ];
    const ws = fs.createWriteStream(file);
    const zw = new ZipWriter(ws, { zip64Threshold: threshold });
    for (const [name, data] of entries) await zw.add(name, data.length, name.startsWith('files/') ? fs.createReadStream(writeTmpFile(dir, data)) : data);
    await zw.finish();
    await once(ws, 'close');
    const z = await openZip(file, { maxEntries: 10, maxTotalBytes: 10_000_000, maxEntryBytes: 10_000_000, maxRatio: 100 });
    try {
      expect(z.entries.map((e) => e.name)).toEqual(entries.map((e) => e[0]));
      for (const [i, [, data]] of entries.entries()) {
        const parts: Buffer[] = [];
        for await (const c of await z.openStream(z.entries[i]!, 10_000_000)) parts.push(c as Buffer);
        expect(Buffer.concat(parts).equals(data)).toBe(true);
        expect(z.entries[i]!.raw.crc32).toBe(zlib.crc32(data));
      }
    } finally {
      z.close();
    }
  });
});

function writeTmpFile(dir: string, data: Buffer): string {
  const p = path.join(dir, crypto.randomBytes(4).toString('hex'));
  fs.writeFileSync(p, data);
  return p;
}

describe('Export/Import einer Bibliothek bzw. eines Fachs', () => {
  async function seed(a: TestApp) {
    const sub = (await a.api<{ id: number }>('POST', '/api/subjects', { name: 'Physik', color: '#39e6ff' })).data;
    const other = (await a.api<{ id: number }>('POST', '/api/subjects', { name: 'Mathe', color: '#b56cff' })).data;
    const s1 = (await a.upload('thermo.md', '# Thermo\n\nEntropie ist ein Maß für Unordnung.\n\n## Teil 2\n\nCarnot-Prozess und Wirkungsgrad.', { subjectId: sub.id })).data.source;
    const z = (await a.upload('blatt.zip', makeZip({ 'a/aufgabe.md': '# Aufgabe\n\nIsotherme Expansion berechnen.' }), { subjectId: sub.id })).data.source;
    const m = (await a.upload('analysis.txt', 'Folgen und Reihen.', { subjectId: other.id })).data.source;
    for (const s of [s1, z, m]) await waitForSource(a, s.id);
    const db = a.hotspot.services.db;
    const chunk = db.prepare('SELECT id, text FROM chunks WHERE source_id = ? ORDER BY ord LIMIT 1').get(s1.id) as { id: number; text: string };
    db.prepare(
      "INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, chunk_id, source_name, reps, ease, interval_days, due, created_at, updated_at) VALUES ('qa', 'Was ist Entropie?', 'Maß für Unordnung', 'active', 1, ?, ?, ?, 'thermo.md', 2, 2.6, 6, 123, 1, 1)",
    ).run(sub.id, s1.id, chunk.id);
    db.prepare('INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (1, 3, 10, 1, 2.5), (1, 4, 20, 6, 2.6)').run();
    db.prepare(
      "INSERT INTO notes(title, body, level, scope, citations, subject_id, ai, created_at, updated_at) VALUES ('Thermo', '- Entropie [1]', 'outline', '{\"kind\":\"subject\",\"id\":1,\"truncated\":true}', ?, ?, 1, 1, 1)",
    ).run(JSON.stringify([{ n: 1, chunkId: chunk.id, sourceId: s1.id, sourceName: 'thermo.md', loc: { k: 'section', s: null, e: null, l: 'Thermo' }, heading: 'Thermo' }]), sub.id);
    db.prepare(
      "INSERT INTO quiz_questions(type, question, options, answer, fingerprint, subject_id, source_id, chunk_id, source_name, created_at) VALUES ('mc', 'Entropie?', '[\"Unordnung\",\"Masse\"]', 'Unordnung', 'fp-entropie', ?, ?, ?, 'thermo.md', 1)",
    ).run(sub.id, s1.id, chunk.id);
    // Karte des anderen Fachs gehört nicht in den Fach-Export
    db.prepare("INSERT INTO cards(type, front, back, status, subject_id, created_at, updated_at) VALUES ('qa', 'Folge?', 'Liste', 'active', ?, 1, 1)").run(other.id);
    return { sub, s1, chunkText: chunk.text };
  }

  it('Fach exportieren -> in leere Bibliothek importieren: Quellen, Abschnitte, Karten mit Verlauf, Notizen, Fragen, Verweise neu verknüpft; zweiter Import = nur Duplikate', async () => {
    const a = await app();
    const { sub, chunkText } = await seed(a);
    const zip = await exportFile(a, sub.id);
    const b = await app();
    const r = await importFile(b, zip);
    expect(r.status).toBe(200);
    expect(r.data.subjects).toEqual({ created: 1, merged: 0 });
    expect(r.data.sources).toMatchObject({ added: 3, duplicate: 0, skipped: 0 }); // thermo.md, blatt.zip, Archiv-Eintrag
    expect(r.data.files.invalid).toBe(0);
    expect(r.data.cards).toEqual({ added: 1, duplicate: 0 });
    expect(r.data.notes).toEqual({ added: 1, duplicate: 0 });
    expect(r.data.questions).toEqual({ added: 1, duplicate: 0 });
    expect(r.data.skippedRecords).toBe(0);
    const db = b.hotspot.services.db;
    expect((db.prepare('SELECT name FROM subjects').all() as { name: string }[]).map((x) => x.name)).toEqual(['Physik']);
    const card = db.prepare('SELECT c.*, ch.text AS chunk_text, s.name AS sname FROM cards c JOIN chunks ch ON ch.id = c.chunk_id JOIN sources s ON s.id = c.source_id').get() as Record<string, unknown>;
    expect(card).toMatchObject({ front: 'Was ist Entropie?', chunk_text: chunkText, sname: 'thermo.md', interval_days: 6, ease: 2.6 });
    expect(db.prepare('SELECT rating FROM reviews ORDER BY reviewed_at').all()).toEqual([{ rating: 3 }, { rating: 4 }]);
    const note = (await b.api<{ citations: { sourceId: number; chunkId: number; deleted: boolean }[]; scope: Record<string, unknown> }>('GET', '/api/notes/1')).data;
    const s1b = db.prepare("SELECT id FROM sources WHERE name = 'thermo.md'").get() as { id: number };
    expect(note.citations[0]).toMatchObject({ sourceId: s1b.id, deleted: false });
    expect(note.scope).toEqual({ truncated: true }); // keine IDs der Ursprungs-DB
    const child = db.prepare('SELECT parent_id, status FROM sources WHERE name = ?').get('aufgabe.md') as { parent_id: number; status: string };
    expect(child.parent_id).toBe((db.prepare("SELECT id FROM sources WHERE name = 'blatt.zip'").get() as { id: number }).id);
    // Volltext sofort, Vektoren werden nachberechnet
    expect((await b.api<{ hits: unknown[] }>('GET', '/api/search?q=Carnot')).data.hits.length).toBeGreaterThan(0);
    await waitForEmbeddings(b);
    expect((db.prepare('SELECT count(*) AS n FROM embeddings').get() as { n: number }).n).toBe((db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }).n);
    // Originaldatei abrufbar
    expect(await (await fetch(`${b.url}/api/sources/${s1b.id}/file?t=${b.token}`)).text()).toContain('Entropie ist ein Maß');

    const again = await importFile(b, zip);
    expect(again.data).toMatchObject({ subjects: { created: 0, merged: 1 }, sources: { added: 0, duplicate: 3 }, cards: { added: 0, duplicate: 1 }, notes: { added: 0, duplicate: 1 }, questions: { added: 0, duplicate: 1 } });
  });

  it('komplette Bibliothek exportieren enthält alle Fächer; Import in dieselbe Bibliothek ändert nichts', async () => {
    const a = await app();
    await seed(a);
    await waitForEmbeddings(a); // sonst zählt die Vektor-Spalte zwischen den Messungen weiter
    const before = a.hotspot.services.library.stats();
    const zip = await exportFile(a, 'all');
    const r = await importFile(a, zip);
    expect(r.data.subjects).toEqual({ created: 0, merged: 2 });
    expect(r.data.sources.added).toBe(0);
    expect(r.data.cards).toEqual({ added: 0, duplicate: 2 });
    expect(a.hotspot.services.library.stats()).toEqual(before);
  });

  it('unbekanntes Fach beim Export -> 404 (kein halber Download)', async () => {
    const a = await app();
    const r = await fetch(`${a.url}/api/library/export?subject=999&t=${a.token}`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toBe('not_found');
    // Token per Query nur für GET auf genau diese Route
    expect((await fetch(`${a.url}/api/library/import?t=${a.token}`, { method: 'POST' })).status).toBe(401);
  });
});

describe('Import: Angriffe und kaputte Dateien', () => {
  it('keine ZIP-Datei / Zip-Slip / Symlink-Eintrag / Zip-Bombe / fremdes Format / neuere Version', async () => {
    const a = await app();
    expect((await importFile(a, Buffer.from('hallo'))).data).toMatchObject({ error: 'import_invalid', detail: 'zip_invalid' });
    const slip = makeZip({ 'manifest.json': manifest(), 'library.jsonl': '', '../../evil.txt': 'böse' });
    expect((await importFile(a, slip)).data).toMatchObject({ error: 'import_invalid', detail: 'zip_unsafe_path' });
    const link = Buffer.from(zipSync({ 'manifest.json': strToU8(manifest()), 'library.jsonl': strToU8(''), 'files/x': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }));
    expect((await importFile(a, link)).data).toMatchObject({ error: 'import_invalid', detail: 'entry' });
    const zeros = new Uint8Array(60 * 1024 * 1024);
    const bomb = makeZip({ 'manifest.json': manifest(), 'library.jsonl': '', [`files/${sha(Buffer.from(zeros))}`]: zeros }, 9);
    expect((await importFile(a, bomb)).data).toMatchObject({ error: 'import_invalid', detail: 'zip_bomb' });
    expect((await importFile(a, makeZip({ 'manifest.json': '{"format":"anders"}', 'library.jsonl': '' }))).data).toMatchObject({ error: 'import_invalid', detail: 'manifest' });
    expect((await importFile(a, makeZip({ 'manifest.json': manifest(2), 'library.jsonl': '' }))).data.error).toBe('import_too_new');
    expect(a.hotspot.services.library.stats().sources).toBe(0);
    expect(fs.readdirSync(path.join(a.dataDir, 'files')).length).toBe(0);
  });

  it('Riesenzeile in library.jsonl wird abgelehnt (keine Speicher-Bombe)', async () => {
    const a = await app();
    const zip = makeZip({ 'manifest.json': manifest(), 'library.jsonl': '{"t":"note","title":"' + 'x'.repeat(9 * 1024 * 1024) }, 6);
    expect((await importFile(a, zip)).data).toMatchObject({ error: 'import_invalid', detail: 'line' });
  });

  it('falscher Inhalt zum SHA-256-Namen, Typ-Täuschung, Pfad im Namen, kaputte Datensätze', async () => {
    const a = await app();
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script>Hallo</body></html>');
    const good = Buffer.from('Normale Notizen über Optik.');
    const lies = Buffer.from('anderer Inhalt');
    const recs = [
      { t: 'subject', key: 1, name: 'Optik', color: 'red;background:url(x)' },
      // HTML-Datei gibt sich als Bild mit fertigen Abschnitten aus -> Typ wird aus dem Inhalt neu erkannt, Abschnitte verworfen
      { t: 'source', key: 1, subject: 1, sha256: sha(html), name: '../../seite.png', relPath: '../../../x/y', kind: 'image', status: 'ready' },
      { t: 'chunk', source: 1, ord: 0, text: 'GEFÄLSCHT', loc: ['page', 1, 1, null] },
      { t: 'source', key: 2, subject: 1, sha256: sha(good), name: 'optik.txt', kind: 'text', status: 'ready' },
      { t: 'chunk', source: 2, ord: 0, text: 'Normale Notizen über Optik.', loc: ['lines', 1, 1, null], origin: 'evil' },
      { t: 'source', key: 3, sha256: sha('fehlt'), name: 'weg.txt', kind: 'text', status: 'ready' },
      { t: 'card', type: 'evil', front: 'x', back: 'y', status: 'active' },
      { t: 'card', type: 'qa', front: 'F', back: 'B', status: 'active', ease: 99, reps: -5, source: 2, chunkOrd: 0, reviews: [[9, 1, 1, 2.5], [3, 'x'], [2, 5, 1, 2.3]] },
      { t: 'question', type: 'mc', question: 'Q?', answer: 'A', fingerprint: 'fp', options: '{"kein":"array"}' },
      { t: 'unbekannt' },
    ];
    const zip = makeZip({
      'manifest.json': manifest(),
      [`files/${sha(html)}`]: html,
      [`files/${sha(good)}`]: good,
      [`files/${sha('soll-so-heissen')}`]: lies,
      'library.jsonl': recs.map((r) => JSON.stringify(r)).join('\n') + '\nkein json\n',
    });
    const r = await importFile(a, zip);
    expect(r.status).toBe(200);
    expect(r.data.files).toEqual({ added: 2, existing: 0, invalid: 1 });
    expect(r.data.sources).toMatchObject({ added: 2, skipped: 1 });
    expect(r.data.skippedRecords).toBe(3); // Karte mit falschem Typ, unbekannter Datensatz, keine JSON-Zeile
    const db = a.hotspot.services.db;
    const s = db.prepare('SELECT name, rel_path, kind, mime FROM sources ORDER BY id').all();
    expect(s[0]).toMatchObject({ name: 'seite.png', rel_path: 'x/y', kind: 'other', mime: 'application/octet-stream' });
    expect(db.prepare("SELECT count(*) AS n FROM chunks WHERE text = 'GEFÄLSCHT'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT origin FROM chunks WHERE text LIKE ?').get('Normale%')).toEqual({ origin: null });
    expect(db.prepare('SELECT color FROM subjects').get()).toEqual({ color: '#39e6ff' });
    expect(db.prepare('SELECT ease, reps FROM cards').get()).toEqual({ ease: 2.5, reps: 0 });
    expect(db.prepare('SELECT rating FROM reviews ORDER BY id').all()).toEqual([{ rating: 2 }]);
    expect(db.prepare('SELECT options FROM quiz_questions').get()).toEqual({ options: null });
    // falscher Inhalt liegt nicht im Speicher
    expect(fs.existsSync(path.join(a.dataDir, 'files', sha(lies).slice(0, 2), sha(lies)))).toBe(false);
    // HTML wird nie inline ausgeliefert
    const id = (db.prepare("SELECT id FROM sources WHERE name = 'seite.png'").get() as { id: number }).id;
    const f = await fetch(`${a.url}/api/sources/${id}/file?t=${a.token}`);
    expect(f.headers.get('content-type')).toBe('application/octet-stream');
    expect(f.headers.get('content-disposition')).toMatch(/^attachment/);
  });
});

describe('Karteikarten-CSV und Notiz-PDF', () => {
  it('CSV: BOM, Kopfzeile, Anführungszeichen, Schutz gegen Formel-Injektion', async () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    const a = await app();
    await a.api('POST', '/api/cards', { type: 'qa', front: '@SUMME(A1)', back: 'Zeile 1\nZeile 2' });
    const r = await fetch(`${a.url}/api/cards/export.csv`, { headers: { 'x-hotspot-token': a.token } });
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
    expect(text.startsWith('﻿Vorderseite;Rückseite;')).toBe(true); // deutsches Excel: Semikolon
    expect(text).toContain(`'@SUMME(A1);"Zeile 1\nZeile 2";qa;`);
  });

  it('PDF: Browser-Modus -> 501 mit Code; Desktop-Haken liefert das PDF', async () => {
    const a = await app();
    const note = (await a.api<{ id: number }>('POST', '/api/notes', { title: 'Meine/Notiz', body: 'x' })).data;
    expect((await a.api<{ error: string }>('GET', `/api/notes/${note.id}/pdf`)).data.error).toBe('pdf_unavailable');
    const calls: string[] = [];
    const b = await app({ printToPdf: async (p) => (calls.push(p), Buffer.from('%PDF-1.7 fake')) });
    const n2 = (await b.api<{ id: number }>('POST', '/api/notes', { title: 'Meine/Notiz', body: 'x' })).data;
    const r = await fetch(`${b.url}/api/notes/${n2.id}/pdf`, { headers: { 'x-hotspot-token': b.token } });
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toContain('Meine_Notiz.pdf');
    expect(calls).toEqual([`/#/learn/notes?note=${n2.id}&print=1`]);
    expect((await b.api('GET', '/api/notes/999/pdf')).status).toBe(404);
  });
});

describe('Korrekturrunde 1: Import abbruchfest, Zeitstempel, Dedupe ohne Volltextvergleich, Download-Abbruch', () => {
  /** Export-Datei aus Datensätzen + Dateien bauen */
  const exportZip = (recs: object[], files: Buffer[] = []) => {
    const entries: Record<string, string | Uint8Array> = { 'manifest.json': manifest() };
    for (const f of files) entries[`files/${sha(f)}`] = f;
    entries['library.jsonl'] = recs.map((r) => JSON.stringify(r)).join('\n');
    return makeZip(entries);
  };

  it('K6: Abbruch nach Paket 1 -> angelegte Quellen werden neu verarbeitet (queued), nie halb „fertig“ oder hängend in processing', async () => {
    const a = await app();
    const files = Array.from({ length: 5 }, (_, i) => Buffer.from(`Datei ${i} Inhalt über Optik`));
    const recs: object[] = files.map((f, i) => ({ t: 'source', key: i + 1, sha256: sha(f), name: `f${i}.txt`, kind: 'text', status: 'ready' }));
    files.forEach((f, i) => recs.push({ t: 'chunk', source: i + 1, ord: 0, text: f.toString(), loc: ['lines', 1, 1, null] }));
    for (let i = 0; i < 400; i++) recs.push({ t: 'card', type: 'qa', front: `F${i}`, back: `B${i}`, status: 'active' });
    const zipPath = path.join(tmpDir('impfail'), 'x.zip');
    fs.writeFileSync(zipPath, exportZip(recs, files));
    await a.hotspot.services.ingest.stop(); // Verarbeitung anhalten, damit der Zustand direkt nach dem Abbruch sichtbar ist
    await expect(importLibrary({ db: a.hotspot.services.db, blobs: a.hotspot.services.blobs }, zipPath, { failAfterBatch: 1 })).rejects.toThrow('Abbruch');
    const st = a.hotspot.services.db.prepare('SELECT status, count(*) AS n FROM sources GROUP BY status').all();
    expect(st).toEqual([{ status: 'queued', n: 5 }]);
  });

  it('K11: unsinnige Zeitstempel (1e20, negativ) werden auf jetzt gekappt bzw. verworfen', async () => {
    const a = await app();
    const t0 = Date.now();
    const zip = exportZip([{ t: 'card', type: 'qa', front: 'Zeit', back: 'Reise', status: 'active', createdAt: 1e20, updatedAt: -5, due: 9e15, lastReview: 1e300, reviews: [[3, 1e20, 1, 2.5], [3, 5, 1, 2.5]] }]);
    expect((await importFile(a, zip)).status).toBe(200);
    const c = a.hotspot.services.db.prepare('SELECT created_at, updated_at, due, last_review FROM cards').get() as Record<string, number | null>;
    expect(c.created_at).toBeGreaterThanOrEqual(t0);
    expect(c.created_at).toBeLessThanOrEqual(Date.now());
    expect(c.updated_at).toBeGreaterThanOrEqual(t0);
    expect([c.due, c.last_review]).toEqual([null, null]);
    expect(a.hotspot.services.db.prepare('SELECT reviewed_at FROM reviews').all()).toEqual([{ reviewed_at: 5 }]);
  });

  it('K17/T4: 20 000 Karten in eine Bibliothek mit 20 000 Karten importieren – linear, Event-Loop frei; Lookups nutzen Indizes', async () => {
    const a = await app();
    const db = a.hotspot.services.db;
    db.exec('BEGIN');
    const ins = db.prepare("INSERT INTO cards(type, front, back, status, created_at, updated_at) VALUES ('qa', ?, ?, 'active', 1, 1)");
    for (let i = 0; i < 20_000; i++) ins.run(`Vorhanden ${i} ${'x'.repeat(40)}`, `Antwort ${i}`);
    db.exec('COMMIT');
    const recs = Array.from({ length: 20_000 }, (_, i) => ({ t: 'card', type: 'qa', front: `Neu ${i} ${'y'.repeat(40)}`, back: `Antwort ${i}`, status: 'active', reviews: [[3, 1000 + i, 1, 2.5]] }));
    recs.push({ t: 'card', type: 'qa', front: `Vorhanden 7 ${'x'.repeat(40)}`, back: 'Antwort 7', status: 'active', reviews: [] });
    const eld = monitorEventLoopDelay({ resolution: 5 });
    eld.enable();
    const t = performance.now();
    const r = await importFile(a, exportZip(recs));
    const ms = performance.now() - t;
    eld.disable();
    expect(r.data.cards).toEqual({ added: 20_000, duplicate: 1 });
    console.log(`INFO Import 20 000 Karten (+20 000 vorhanden): ${Math.round(ms)} ms, Event-Loop max ${Math.round(eld.max / 1e6)} ms`);
    // Obergrenzen großzügig (30x-Schleife, parallele Testdateien); gemessen ~1–2 s / < 100 ms (README)
    expect(ms).toBeLessThan(30_000);
    expect(eld.max / 1e6).toBeLessThan(1000);
    const plan = (sql: string, ...p: (string | number)[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p) as { detail: string }[]).map((x) => x.detail).join(' ');
    expect(plan('SELECT id FROM sources WHERE sha256 = ?', 'a')).toMatch(/USING (COVERING )?INDEX/);
    expect(plan('SELECT id FROM chunks WHERE source_id = ? AND ord = ?', 1, 0)).toMatch(/USING (COVERING )?INDEX chunks_source/);
  }, 120_000);

  it('K9: abgebrochener Export-Download hinterlässt keine Zwischendatei und hängt nicht', async () => {
    const a = await app();
    const big = crypto.randomBytes(24 * 1024 * 1024);
    const up = (await a.upload('gross.bin', big)).data.source;
    await waitForSource(a, up.id);
    const ctrl = new AbortController();
    const res = await fetch(`${a.url}/api/library/export?subject=all&t=${a.token}`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctrl.abort();
    await reader.cancel().catch(() => {});
    const tmp = a.hotspot.services.blobs.tmpDir;
    await waitFor(() => !fs.readdirSync(tmp).some((f) => f.startsWith('export-')), { message: 'Zwischendatei weg', timeout: 15_000 });
  });

  it('K9: ZipWriter wartet auf "drain" und die Ausgabe wird ohne Fehler geschlossen -> Abbruch statt ewigem Warten', async () => {
    // Gegenstelle liest nie (Puffer voll), dann schließt sie: "drain" kommt nie
    const out = new Writable({ highWaterMark: 16, write() {} });
    const zw = new ZipWriter(out);
    const pending = zw.add('a.bin', 1024, Buffer.alloc(1024));
    setTimeout(() => out.destroy(), 50);
    const r = await Promise.race([pending.then(() => 'fertig', (e: NodeJS.ErrnoException) => e.code ?? 'Fehler'), new Promise((res) => setTimeout(() => res('hängt'), 2000))]);
    expect(r).toBe('ERR_STREAM_DESTROYED');
  });
});