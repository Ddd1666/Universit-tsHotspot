import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDocx, makePdf, makePptx, makeXlsx, makeZip } from './fixtures.ts';
import { startTestApp, tmpDir, waitFor, waitForEmbeddings, waitForSource, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});
async function start(opts: Parameters<typeof startTestApp>[0] = {}) {
  const a = await startTestApp(opts);
  apps.push(a);
  return a;
}

describe('Import & Verarbeitung', () => {
  it('importiert mehrere Formate, speichert jede Datei und indexiert Text', async () => {
    const app = await start();
    const files: [string, Buffer | string, string][] = [
      ['skript.pdf', makePdf([['Thermodynamik Seite eins'], ['Entropie auf Seite zwei']]), 'ready'],
      ['arbeit.docx', makeDocx([{ text: 'Hausarbeit über Photosynthese' }]), 'ready'],
      ['folien.pptx', makePptx([{ title: 'Zellbiologie', body: ['Mitochondrien'] }]), 'ready'],
      ['noten.xlsx', makeXlsx([{ name: 'Noten', rows: [['Fach', 'Note'], ['Chemie', 2]] }]), 'ready'],
      ['liste.csv', 'a;b\n1;2\n', 'ready'],
      ['notiz.md', '# Titel\n\nMarkdown-Inhalt', 'ready'],
      ['foto.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'unsupported'],
      ['vorlesung.mp4', Buffer.from('....ftypisom'), 'unsupported'],
      ['alt.doc', Buffer.from('d0cf11e0a1b11ae1000000', 'hex'), 'unsupported'],
      ['daten.bin', Buffer.from([0, 0, 1, 2, 0, 3]), 'unsupported'],
    ];
    for (const [name, data, expected] of files) {
      const r = await app.upload(name, data);
      expect(r.status, name).toBe(200);
      const s = await waitForSource(app, r.data.source.id);
      expect(s.status, name).toBe(expected);
      if (expected === 'ready') expect(s.chunkCount, name).toBeGreaterThan(0);
    }
    const list = (await app.api<{ items: { name: string; sha256: string; size: number; mime: string; importedAt: number }[] }>('GET', '/api/sources')).data.items;
    expect(list).toHaveLength(files.length);
    for (const s of list) {
      expect(s.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.existsSync(app.hotspot.services.blobs.pathFor(s.sha256))).toBe(true);
    }
    const img = list.find((s) => s.name === 'foto.jpg') as unknown as { statusDetail: string; mime: string };
    expect(img.statusDetail).toBe('phase2_media');
    expect(img.mime).toBe('image/jpeg');
  });

  it('dedupliziert identische Inhalte (Content-Addressing)', async () => {
    const app = await start();
    const a = await app.upload('eins.txt', 'gleicher Inhalt');
    const b = await app.upload('zwei-anderer-name.txt', 'gleicher Inhalt');
    expect(a.data.status).toBe('created');
    expect(b.data.status).toBe('duplicate');
    expect(b.data.source.id).toBe(a.data.source.id);
    expect(app.hotspot.services.blobs.listHashes()).toHaveLength(1);
  });

  it('Fehler pro Datei brechen den Import nicht ab', async () => {
    const app = await start();
    const bad = await app.upload('kaputt.pdf', '%PDF-1.7 das ist kein echtes PDF');
    const good = await app.upload('ok.txt', 'Alles gut');
    expect((await waitForSource(app, bad.data.source.id)).status).toBe('error');
    expect((await waitForSource(app, good.data.source.id)).status).toBe('ready');
  });

  it('Abbrechen eines Import-Vorgangs: Dateien bleiben gespeichert, Status "abgebrochen", später erneut verarbeitbar', async () => {
    const app = await start();
    await app.hotspot.services.ingest.stop(); // Queue anhalten, damit Dateien "wartend" bleiben
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push((await app.upload(`d${i}.txt`, `Datei ${i}`, { batchId: 'batch-1' })).data.source.id);
    const r = await app.api<{ cancelled: number }>('POST', '/api/import/cancel', { batchId: 'batch-1' });
    expect(r.data.cancelled).toBe(3);
    app.hotspot.services.ingest.start();
    for (const id of ids) expect((await waitForSource(app, id)).status).toBe('cancelled');
    await app.api('POST', `/api/sources/${ids[0]}/retry`);
    expect((await waitForSource(app, ids[0]!, ['ready'])).status).toBe('ready');
  });

  it('Queue ist neustartfest: unterbrochene Verarbeitung wird nach Neustart fortgesetzt', async () => {
    const dataDir = tmpDir('restart');
    const app1 = await startTestApp({ dataDir });
    await app1.hotspot.services.ingest.stop();
    const up = await app1.upload('nach-neustart.txt', 'Dieser Text wird erst nach dem Neustart indexiert.');
    // Absturz während der Verarbeitung simulieren
    app1.hotspot.services.db.prepare("UPDATE sources SET status = 'processing' WHERE id = ?").run(up.data.source.id);
    await app1.close();

    const app2 = await start({ dataDir });
    const s = await waitForSource(app2, up.data.source.id);
    expect(s.status).toBe('ready');
    expect(s.chunkCount).toBe(1);
  });

  it('Ollama-Ausfall: Text ist durchsuchbar, Embeddings bleiben ausstehend und werden nachgeholt', async () => {
    const app = await start();
    app.hotspot.mock!.setDown(true);
    await app.hotspot.services.monitor.refresh();
    const up = await app.upload('offline.md', 'Quantenmechanik beschreibt Wellenfunktionen.');
    await waitForSource(app, up.data.source.id);
    const status = await waitFor(() => {
      const st = app.hotspot.services.embed.status();
      return st.state === 'waiting_ollama' ? st : null;
    });
    expect(status.pending).toBe(1);
    // Volltextsuche funktioniert trotzdem
    const search = await app.api<{ hits: unknown[]; mode: string }>('GET', '/api/search?q=Quantenmechanik');
    expect(search.data.hits).toHaveLength(1);
    expect(search.data.mode).toBe('fts');
    // Ollama wieder da -> wird automatisch nachgeholt
    app.hotspot.mock!.setDown(false);
    await app.hotspot.services.monitor.refresh();
    app.hotspot.services.embed.notify();
    const done = await waitForEmbeddings(app);
    expect(done.done).toBe(1);
  });

  it('Modellwechsel verlangt Re-Index; fehlendes Embedding-Modell wird klar gemeldet', async () => {
    const app = await start();
    const up = await app.upload('x.txt', 'Text für Embedding');
    await waitForSource(app, up.data.source.id);
    const first = await waitForEmbeddings(app);
    expect(first.indexModel).toBe('nomic-embed-text');
    expect(first.indexDim).toBe(768);

    await app.api('PUT', '/api/settings', { embeddingModel: 'bge-m3' });
    expect(app.hotspot.services.embed.status().reindexNeeded).toBe(true);
    // bge-m3 ist im Mock nicht installiert -> Re-Index wird abgelehnt, der vorhandene Index bleibt erhalten
    const refused = await app.api<{ error: string; detail: string }>('POST', '/api/index/reindex');
    expect(refused.status).toBe(409);
    expect(refused.data).toMatchObject({ error: 'model_missing', detail: 'bge-m3' });
    expect(app.hotspot.services.embed.status()).toMatchObject({ indexModel: 'nomic-embed-text', done: 1, pending: 0 });

    await app.api('PUT', '/api/settings', { embeddingModel: 'nomic-embed-text' });
    await app.api('POST', '/api/index/reindex');
    const ok = await waitForEmbeddings(app);
    expect(ok.indexModel).toBe('nomic-embed-text');
    expect(ok.done).toBe(1);
    expect(ok.reindexNeeded).toBe(false);
  });

  it('fehlendes Embedding-Modell beim ersten Index wird klar gemeldet (Daten bleiben ausstehend)', async () => {
    const app = await start();
    await app.api('PUT', '/api/settings', { embeddingModel: 'bge-m3' });
    const up = await app.upload('y.txt', 'Text ohne Embedding-Modell');
    await waitForSource(app, up.data.source.id);
    const st = await waitFor(() => {
      const s = app.hotspot.services.embed.status();
      return s.state === 'model_missing' ? s : null;
    });
    expect(st.lastError).toMatch(/ollama pull bge-m3/);
    expect(st.pending).toBe(1);
  });
});

describe('Große Dateien blockieren den Server nicht', () => {
  it('Chunks werden paketweise mit Event-Loop-Pausen geschrieben (60 000 Chunks)', async () => {
    const app = await start();
    const { db, ingest } = app.hotspot.services;
    await ingest.stop();
    const id = Number(
      db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at) VALUES (?, 'riesig.txt', 1, 'text/plain', 'text', 'processing', 0)").run('d'.repeat(64)).lastInsertRowid,
    );
    const chunks = Array.from({ length: 60_000 }, (_, i) => ({
      text: `Abschnitt ${i} über Thermodynamik und Entropie.`,
      heading: null,
      locKind: 'lines' as const,
      locStart: i,
      locEnd: i,
      locLabel: null,
      tokenEst: 10,
    }));
    // Deterministisch statt zeitbasiert (lastabhängig): wie oft kommt der Event-Loop während des Speicherns dran?
    let turns = 0;
    let running = true;
    const tick = () => {
      if (!running) return;
      turns++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const { monitorEventLoopDelay } = await import('node:perf_hooks');
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await ingest.storeChunks(id, { chunks, pages: null, warnings: [] });
    h.disable();
    running = false;
    expect(turns).toBeGreaterThan(100); // 60 000 / 200 = 300 Pakete; vorher eine einzige Transaktion: 0–1
    expect(h.max / 1e6).toBeLessThan(2000); // grobe Obergrenze (unter Last großzügig)
    expect(app.hotspot.services.library.getSource(id)).toMatchObject({ status: 'ready', chunkCount: 60_000 });
    const fts = db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'abschnitt'").get() as { n: number };
    expect(fts.n).toBe(60_000);
  });

  it('Abbruch während des Schreibens entfernt bereits geschriebene Chunks', async () => {
    const app = await start();
    const { db, ingest } = app.hotspot.services;
    await ingest.stop();
    const id = Number(
      db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at) VALUES (?, 'x.txt', 1, 'text/plain', 'text', 'processing', 0)").run('c'.repeat(64)).lastInsertRowid,
    );
    let batches = 0;
    const chunks = Array.from({ length: 5000 }, (_, i) => ({ text: `T ${i}`, heading: null, locKind: null, locStart: null, locEnd: null, locLabel: null, tokenEst: 1 }));
    await expect(ingest.storeChunks(id, { chunks, pages: null, warnings: [] }, () => ++batches > 3)).rejects.toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM chunks WHERE source_id = ?').get(id) as { n: number }).n).toBe(0);
  });
});

describe('ZIP-Import überspringt Werkzeugordner', () => {
  it('__pycache__, .venv, .git, node_modules werden nicht importiert', async () => {
    const app = await start();
    const zip = makeZip({
      'projekt/main.py': 'print("hallo")',
      'projekt/__pycache__/main.cpython-312.pyc': 'bin',
      'projekt/.venv/lib/site.py': 'x',
      'projekt/.git/HEAD': 'ref',
      'projekt/node_modules/a/index.js': 'x',
    });
    const r = await app.upload('projekt.zip', zip);
    const s = await waitForSource(app, r.data.source.id);
    expect(JSON.parse(s.statusDetail!)).toMatchObject({ files: 1, skipped: 4 });
  });
});
