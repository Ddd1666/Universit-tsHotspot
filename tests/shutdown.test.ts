import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { makeZip } from './fixtures.ts';
import { startTestApp, tmpDir, waitFor, waitForSource, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

/** DB nach dem Beenden direkt lesen (ohne neue Instanz, die die Queue sofort weiterverarbeiten würde). */
function readDb<T>(dataDir: string, sql: string, ...params: (string | number)[]): T {
  const db = new DatabaseSync(path.join(dataDir, 'hotspot.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

/** fängt Fehler, die nach close() noch aus Timern geworfen würden ("database is not open") */
function collectUncaught() {
  const errors: unknown[] = [];
  const on = (e: unknown) => errors.push(e);
  process.on('uncaughtException', on);
  return {
    errors,
    stop: () => process.off('uncaughtException', on),
  };
}

describe('Reguläres Beenden während der Verarbeitung', () => {
  it('mitten im Speichern der Chunks: Datei wird wieder eingereiht (nicht "abgebrochen") und nach Neustart vollständig verarbeitet', async () => {
    const dataDir = tmpDir('stop-mid');
    const app1 = await startTestApp({ dataDir });
    const para = 'Absatz über Thermodynamik, Entropie und Kreisprozesse mit genug Text für viele Abschnitte. ';
    const text = Array.from({ length: 30_000 }, (_, i) => `${i}: ${para}`).join('\n\n');
    const up = await app1.upload('gross.txt', text);
    const id = up.data.source.id;
    const db = app1.hotspot.services.db;
    // warten, bis die ersten Pakete geschrieben sind, die Datei aber noch in Arbeit ist
    await waitFor(
      () => {
        const s = db.prepare('SELECT status, (SELECT count(*) FROM chunks WHERE source_id = sources.id) AS n FROM sources WHERE id = ?').get(id) as { status: string; n: number };
        return s.status === 'processing' && s.n > 0;
      },
      { interval: 1, timeout: 20_000, message: 'mitten im Speichern' },
    );
    const uncaught = collectUncaught();
    await app1.close(); // reguläres Beenden (kein Absturz)
    await new Promise((r) => setTimeout(r, 400)); // Queue-Timer hätte hier auf die geschlossene DB zugegriffen
    uncaught.stop();
    expect(uncaught.errors).toEqual([]);

    const after = readDb<{ status: string; status_detail: string | null; n: number }>(
      dataDir,
      'SELECT status, status_detail, (SELECT count(*) FROM chunks WHERE source_id = sources.id) AS n FROM sources WHERE id = ?',
      id,
    );
    expect(after).toEqual({ status: 'queued', status_detail: null, n: 0 });

    const app2 = await startTestApp({ dataDir });
    apps.push(app2);
    const s = await waitForSource(app2, id);
    expect(s.status).toBe('ready');
    expect(s.chunkCount).toBeGreaterThan(1000);
  }, 60_000);

  it('mitten im Entpacken einer ZIP: Archiv bleibt eingereiht und wird nach Neustart fertig entpackt', async () => {
    const dataDir = tmpDir('stop-zip');
    const app1 = await startTestApp({ dataDir });
    const entries: Record<string, string> = {};
    for (let i = 0; i < 400; i++) entries[`blatt/datei-${i}.txt`] = `Inhalt Nummer ${i} – ${'x'.repeat(i % 50)}`;
    const up = await app1.upload('sammlung.zip', makeZip(entries));
    const id = up.data.source.id;
    const db = app1.hotspot.services.db;
    await waitFor(
      () => {
        const s = db.prepare('SELECT status, (SELECT count(*) FROM sources c WHERE c.parent_id = sources.id) AS n FROM sources WHERE id = ?').get(id) as { status: string; n: number };
        return s.status === 'processing' && s.n > 0;
      },
      { interval: 1, timeout: 20_000, message: 'mitten im Entpacken' },
    );
    await app1.close();
    const after = readDb<{ status: string }>(dataDir, 'SELECT status FROM sources WHERE id = ?', id);
    expect(after.status).toBe('queued');

    const app2 = await startTestApp({ dataDir });
    apps.push(app2);
    const s = await waitForSource(app2, id);
    expect(s.status).toBe('archive');
    const children = app2.hotspot.services.db.prepare('SELECT count(*) AS n FROM sources WHERE parent_id = ?').get(id) as { n: number };
    expect(children.n).toBe(400);
  }, 60_000);

  it('vom Nutzer abgebrochene Datei bleibt "abgebrochen", auch wenn danach beendet wird', async () => {
    const dataDir = tmpDir('stop-user');
    const app1 = await startTestApp({ dataDir });
    const text = Array.from({ length: 30_000 }, (_, i) => `${i}: Absatz über Optik und Linsen mit genug Text für viele Abschnitte.`).join('\n\n');
    const up = await app1.upload('optik.txt', text, { batchId: 'b-1' });
    const id = up.data.source.id;
    const db = app1.hotspot.services.db;
    await waitFor(() => (db.prepare('SELECT status FROM sources WHERE id = ?').get(id) as { status: string }).status === 'processing', { interval: 1 });
    await app1.api('POST', '/api/import/cancel', { batchId: 'b-1' });
    await app1.close();
    expect(readDb<{ status: string }>(dataDir, 'SELECT status FROM sources WHERE id = ?', id).status).toBe('cancelled');
  }, 60_000);
});

describe('Beenden ohne Nachzügler', () => {
  it('nach close() greift kein Queue-Timer mehr auf die geschlossene Datenbank zu', async () => {
    const app = await startTestApp();
    const ingest = app.hotspot.services.ingest;
    const origStop = ingest.stop.bind(ingest);
    // wie ein laufender Job, der beim Stoppen noch eine Queue-Änderung meldet
    ingest.stop = async () => {
      await origStop();
      app.hotspot.services.notifyQueue();
    };
    const uncaught = collectUncaught();
    await app.close();
    await new Promise((r) => setTimeout(r, 400));
    uncaught.stop();
    expect(uncaught.errors).toEqual([]);
  });
});
