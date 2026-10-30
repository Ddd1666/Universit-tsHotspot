import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { applyPendingRestore, inspectDbFile } from '../server/backup.ts';
import { SCHEMA_VERSION } from '../server/db.ts';
import { startTestApp, tmpDir, waitFor, waitForSource, type TestApp } from './helpers.ts';

const open: TestApp[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close().catch(() => {});
});
async function app(dataDir?: string, extra: Parameters<typeof startTestApp>[0] = {}) {
  const a = await startTestApp({ ...(dataDir ? { dataDir } : {}), ...extra });
  open.push(a);
  return a;
}
const count = (a: TestApp, table: string) => (a.hotspot.services.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
type Backups = { items: { id: string; reason: string; files: number; missing: number }[]; dir: string; restarting?: boolean };

/** Bibliothek mit Fach, 2 Quellen, Karte (mit Wiederholung), Notiz. */
async function seed(a: TestApp) {
  const sub = (await a.api<{ id: number }>('POST', '/api/subjects', { name: 'Physik', color: '#39e6ff' })).data;
  const s1 = (await a.upload('thermo.md', '# Thermo\n\nEntropie ist ein Maß für Unordnung.', { subjectId: sub.id })).data.source;
  const s2 = (await a.upload('optik.txt', 'Brechung des Lichts an Grenzflächen.', { subjectId: sub.id })).data.source;
  await waitForSource(a, s1.id);
  await waitForSource(a, s2.id);
  const card = (await a.api<{ id: number }>('POST', '/api/cards', { type: 'qa', front: 'Was ist Entropie?', back: 'Maß für Unordnung', subjectId: sub.id })).data;
  a.hotspot.services.db.prepare("UPDATE cards SET status = 'active' WHERE id = ?").run(card.id);
  a.hotspot.services.db.prepare('INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (?, 3, 1, 1, 2.5)').run(card.id);
  await a.api('POST', '/api/notes', { title: 'Notiz A', body: 'Text **fett**' });
  return { sub, s1, s2 };
}

describe('Sicherung → Wiederherstellung (Roundtrip)', () => {
  it('Snapshot ist eigenständig (DB ohne WAL, Dateien, Manifest) und stellt den gesicherten Zustand wieder her', async () => {
    const dir = tmpDir('bk');
    const a = await app(dir);
    const { s1, s2 } = await seed(a);
    const snap = (await a.api<{ snapshot: { id: string; files: number; schemaVersion: number } }>('POST', '/api/backups')).data.snapshot;
    expect(snap.files).toBe(2);
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    const sdir = path.join(dir, 'backups', snap.id);
    expect(fs.existsSync(path.join(sdir, 'hotspot.sqlite-wal'))).toBe(false);
    expect(inspectDbFile(path.join(sdir, 'hotspot.sqlite')).version).toBe(SCHEMA_VERSION);

    // Zustand danach verändern: Quelle + Notiz löschen, neues Fach
    await a.api('DELETE', `/api/sources/${s2.id}`);
    await a.api('POST', '/api/subjects', { name: 'Neu', color: '#b56cff' });
    expect(count(a, 'sources')).toBe(1);

    const r = await a.api<{ preRestore: string; missingFiles: number; restarting: boolean }>('POST', `/api/backups/${snap.id}/restore`, { confirm: true });
    expect(r.status).toBe(200);
    expect(r.data.restarting).toBe(false); // Testumgebung ohne Neustart-Haken
    expect(r.data.missingFiles).toBe(0);
    expect(r.data.preRestore).toMatch(/-pre-restore$/);
    expect(fs.existsSync(path.join(dir, 'restore-pending.json'))).toBe(true);
    await a.close();

    const b = await app(dir);
    expect(b.hotspot.services.lastRestore).toEqual({ ok: true, id: snap.id });
    expect(fs.existsSync(path.join(dir, 'restore-pending.json'))).toBe(false);
    expect(count(b, 'sources')).toBe(2);
    expect(count(b, 'subjects')).toBe(1);
    expect(count(b, 'cards')).toBe(1);
    expect(count(b, 'reviews')).toBe(1);
    expect(count(b, 'notes')).toBe(1);
    expect((b.hotspot.services.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    // Originaldatei der zwischenzeitlich gelöschten Quelle ist wieder da und abrufbar
    const file = await fetch(`${b.url}/api/sources/${s2.id}/file?t=${b.token}`);
    expect(await file.text()).toBe('Brechung des Lichts an Grenzflächen.');
    // Volltextsuche funktioniert (FTS mitgesichert)
    const hits = await b.api<{ hits: { sourceId: number }[] }>('GET', '/api/search?q=Entropie');
    expect(hits.data.hits.map((h) => h.sourceId)).toContain(s1.id);
    // Ist-Zustand vor der Wiederherstellung ist als eigener Snapshot erhalten
    const list = (await b.api<Backups>('GET', '/api/backups')).data.items;
    expect(list.map((x) => x.reason).sort()).toEqual(['manual', 'pre-restore']);
  });

  it('Neustart-Haken: Antwort meldet „restarting“, Haken wird nach der Antwort aufgerufen', async () => {
    let called = 0;
    const a = await app(undefined, { requestRestart: () => called++ });
    await seed(a);
    const snap = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot;
    const r = await a.api<{ restarting: boolean }>('POST', `/api/backups/${snap.id}/restore`, { confirm: true });
    expect(r.data.restarting).toBe(true);
    await waitFor(() => called === 1, { message: 'restart' });
  });

  it('ohne Bestätigung keine Wiederherstellung', async () => {
    const a = await app();
    const snap = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot;
    expect((await a.api('POST', `/api/backups/${snap.id}/restore`, {})).status).toBe(400);
    expect((await a.api('POST', `/api/backups/${snap.id}/restore`, { confirm: 'ja' })).status).toBe(400);
    expect(fs.existsSync(path.join(a.dataDir, 'restore-pending.json'))).toBe(false);
  });
});

describe('Absturz-Zwischenzustände (kill)', () => {
  it('halber Snapshot (.partial nach kill) gilt nie als Sicherung und wird beim nächsten Lauf entfernt', async () => {
    const a = await app();
    const target = path.join(a.dataDir, 'backups');
    const partial = path.join(target, 'snapshot-20260101-000000-auto.partial');
    fs.mkdirSync(path.join(partial, 'files'), { recursive: true });
    fs.writeFileSync(path.join(partial, 'hotspot.sqlite'), 'halb');
    expect((await a.api<Backups>('GET', '/api/backups')).data.items).toEqual([]);
    await a.api('POST', '/api/backups');
    expect(fs.existsSync(partial)).toBe(false);
    expect((await a.api<Backups>('GET', '/api/backups')).data.items).toHaveLength(1);
  });

  it('Fehler mitten im Sichern hinterlässt keinen Snapshot', async () => {
    const a = await app();
    await seed(a);
    a.hotspot.services.backup.onStep = (s) => {
      if (s === 'files') throw new Error('kill');
    };
    expect((await a.api<{ error: string }>('POST', '/api/backups')).data.error).toBe('backup_failed');
    a.hotspot.services.backup.onStep = null;
    expect((await a.api<Backups>('GET', '/api/backups')).data.items).toEqual([]);
    expect(fs.readdirSync(path.join(a.dataDir, 'backups')).filter((f) => f.startsWith('snapshot-'))).toEqual([]);
  });

  it('echter kill des Prozesses während des Sicherns: Datenordner bleibt intakt, kein gültiger Snapshot', async () => {
    const dir = tmpDir('bkkill');
    const prep = await app(dir);
    const db = prep.hotspot.services.db;
    // etwas Masse, damit der Snapshot messbar dauert
    db.exec('BEGIN');
    const ins = db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at) VALUES (?, ?, 1, 'text/plain', 'text', 'ready', 1)");
    const ch = db.prepare('INSERT INTO chunks(source_id, ord, text, token_est) VALUES (?, 0, ?, 10)');
    for (let i = 0; i < 3000; i++) ch.run(Number(ins.run(i.toString(16).padStart(64, '0'), `q${i}`).lastInsertRowid), 'x'.repeat(2000));
    db.exec('COMMIT');
    await prep.close();
    const script = path.join(dir, '..', `kill-${process.pid}.ts`);
    const url = (p: string) => JSON.stringify(pathToFileURL(path.join(PROJECT_ROOT, 'server', p)).href);
    fs.writeFileSync(
      script,
      `import { loadConfig } from ${url('config.ts')};
       import { createHotspot } from ${url('app.ts')};
       const hs = await createHotspot(loadConfig({ dataDir: ${JSON.stringify(dir)}, port: 0, mockOllama: true, webDir: null, logToFile: false }));
       await hs.listen();
       // nach der DB-Kopie anhalten: der Snapshot liegt halb fertig unter .partial
       hs.services.backup.onStep = () => { console.log('MITTEN'); return new Promise(() => setInterval(() => {}, 1000)); };
       void hs.services.backup.create('manual');`,
    );
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('kein MITTEN')), 20_000);
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('MITTEN')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.partial'))).toBe(true);
    const after = await app(dir); // übernimmt die verwaiste Sperre
    expect((await after.api<Backups>('GET', '/api/backups')).data.items).toEqual([]);
    expect(count(after, 'sources')).toBe(3000);
    expect((after.hotspot.services.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    await after.api('POST', '/api/backups');
    expect(fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.partial'))).toEqual([]);
  });

  it.each(['copied', 'renamed', 'cleaned'] as const)('Abbruch beim Austausch nach Schritt „%s“: nächster Start führt die Wiederherstellung korrekt zu Ende (auch mit WAL der alten DB)', async (step) => {
    const dir = tmpDir('bkstep');
    const a = await app(dir);
    await seed(a);
    const snap = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot;
    await a.api('POST', '/api/subjects', { name: 'NachDemSnapshot', color: '#b56cff' });
    await a.api('POST', `/api/backups/${snap.id}/restore`, { confirm: true });
    await a.close();
    // Absturz-Zustand nachbauen: alte DB hat ein WAL mit nicht übernommenen Seiten
    const dbFile = path.join(dir, 'hotspot.sqlite');
    const raw = new DatabaseSync(dbFile);
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    raw.exec("INSERT INTO subjects(name, color, created_at) VALUES ('NurImWal', '#ffffff', 1)");
    const walCopy = path.join(dir, 'wal.copy');
    fs.copyFileSync(dbFile + '-wal', walCopy);
    raw.close();
    fs.copyFileSync(walCopy, dbFile + '-wal');
    expect(() =>
      applyPendingRestore(dir, (s) => {
        if (s === step) throw new Error('kill');
      }),
    ).toThrow('kill');
    expect(fs.existsSync(path.join(dir, 'restore-pending.json'))).toBe(true);
    const b = await app(dir);
    expect(b.hotspot.services.lastRestore?.ok).toBe(true);
    const names = (b.hotspot.services.db.prepare('SELECT name FROM subjects ORDER BY name').all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(['Physik']);
    expect((b.hotspot.services.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect(count(b, 'sources')).toBe(2);
  });
});

describe('Wiederherstellen: gefährliche Eingaben werden verweigert', () => {
  async function fakeSnapshot(a: TestApp, id: string, prepare: (dir: string) => void) {
    const sdir = path.join(a.dataDir, 'backups', id);
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'manifest.json'), JSON.stringify({ format: 'uni-hotspot-snapshot', formatVersion: 1, createdAt: Date.now() }));
    prepare(sdir);
    return id;
  }
  const restore = (a: TestApp, id: string) => a.api<{ error: string; detail?: string }>('POST', `/api/backups/${encodeURIComponent(id)}/restore`, { confirm: true });

  it('Pfad-Tricks in der ID: Schema lehnt ab bzw. 404', async () => {
    const a = await app();
    for (const id of ['../../etc', 'snapshot-..%2f..', 'snapshot-x/../../y', 'C:\\Windows']) expect((await restore(a, id)).status).toBeGreaterThanOrEqual(400);
    expect((await restore(a, 'snapshot-20260101-000000-manual')).data.error).toBe('restore_not_found');
  });

  it('keine SQLite-Datei / neuere Schema-Version / manipuliertes Schema / beschädigt', async () => {
    const a = await app();
    const good = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot.id;
    const goodDb = path.join(a.dataDir, 'backups', good, 'hotspot.sqlite');
    const mk = async (n: number, fn: (db: string) => void) =>
      fakeSnapshot(a, `snapshot-20250101-00000${n}-manual`, (d) => {
        fs.copyFileSync(goodDb, path.join(d, 'hotspot.sqlite'));
        fn(path.join(d, 'hotspot.sqlite'));
      });
    const notSqlite = await mk(1, (f) => fs.writeFileSync(f, '<html>kein sqlite</html>'.padEnd(200)));
    expect((await restore(a, notSqlite)).data).toMatchObject({ error: 'restore_invalid', detail: 'not_sqlite' });
    const tooNew = await mk(2, (f) => {
      const db = new DatabaseSync(f);
      db.exec('PRAGMA user_version = 99');
      db.close();
    });
    expect((await restore(a, tooNew)).data.error).toBe('restore_too_new');
    const evil = await mk(3, (f) => {
      const db = new DatabaseSync(f);
      db.exec("CREATE TRIGGER evil AFTER INSERT ON subjects BEGIN DELETE FROM sources; END;");
      db.close();
    });
    expect((await restore(a, evil)).data).toMatchObject({ error: 'restore_invalid', detail: 'schema' });
    const corrupt = await mk(4, (f) => {
      const buf = fs.readFileSync(f);
      buf.fill(0xab, 4096, Math.min(buf.length, 4096 * 3));
      fs.writeFileSync(f, buf);
    });
    expect(['restore_corrupt', 'restore_invalid']).toContain((await restore(a, corrupt)).data.error);
    expect(fs.existsSync(path.join(a.dataDir, 'restore-pending.json'))).toBe(false);
    // nichts wurde vorgemerkt -> kein Ist-Zustand-Snapshot nötig gewesen
    expect((await a.api<Backups>('GET', '/api/backups')).data.items.filter((x) => x.reason === 'pre-restore')).toEqual([]);
  });

  it('Verweis (Junction) im Dateiordner der Sicherung -> verweigert; Junction als Snapshot-Ordner -> nicht gelistet', async () => {
    const a = await app();
    const good = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot.id;
    const outside = tmpDir('outside');
    fs.writeFileSync(path.join(outside, 'geheim.txt'), 'x');
    const id = await fakeSnapshot(a, 'snapshot-20250102-000000-manual', (d) => {
      fs.copyFileSync(path.join(a.dataDir, 'backups', good, 'hotspot.sqlite'), path.join(d, 'hotspot.sqlite'));
      fs.mkdirSync(path.join(d, 'files'));
      fs.symlinkSync(outside, path.join(d, 'files', 'aa'), 'junction');
    });
    expect((await restore(a, id)).data).toMatchObject({ error: 'restore_invalid', detail: 'symlink' });
    const linkId = 'snapshot-20250103-000000-manual';
    fs.symlinkSync(path.join(a.dataDir, 'backups', good), path.join(a.dataDir, 'backups', linkId), 'junction');
    expect((await a.api<Backups>('GET', '/api/backups')).data.items.map((x) => x.id)).not.toContain(linkId);
    expect((await restore(a, linkId)).data.error).toBe('restore_not_found');
  });

  it('Datei mit falschem Inhalt (SHA-256 passt nicht zum Namen) wird nicht übernommen', async () => {
    const dir = tmpDir('bksha');
    const a = await app(dir);
    const { s2 } = await seed(a);
    const snap = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot.id;
    const sha = (a.hotspot.services.db.prepare('SELECT sha256 FROM sources WHERE id = ?').get(s2.id) as { sha256: string }).sha256;
    await a.api('DELETE', `/api/sources/${s2.id}`);
    const inSnap = path.join(dir, 'backups', snap, 'files', sha.slice(0, 2), sha);
    fs.rmSync(inSnap); // Hardlink lösen, dann manipulieren
    fs.writeFileSync(inSnap, 'manipuliert');
    const r = await a.api<{ missingFiles: number }>('POST', `/api/backups/${snap}/restore`, { confirm: true });
    expect(r.data.missingFiles).toBe(1);
    expect(fs.existsSync(path.join(dir, 'files', sha.slice(0, 2), sha))).toBe(false);
  });
});

describe('Migration bei Wiederherstellung alter Sicherungen (Phase 1/2/3)', () => {
  it.each([
    ['phase1.sqlite', 2],
    ['phase2.sqlite', 3],
    ['phase3.sqlite', 4],
  ])('%s wird geprüft, eingespielt und beim Start migriert (Schema v%i -> aktuell, Auto-Backup)', async (fixture, from) => {
    const dir = tmpDir('bkmig');
    const a = await app(dir);
    const id = `snapshot-20240101-00000${from}-manual`;
    const sdir = path.join(dir, 'backups', id);
    fs.mkdirSync(sdir, { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', fixture), path.join(sdir, 'hotspot.sqlite'));
    fs.writeFileSync(path.join(sdir, 'manifest.json'), JSON.stringify({ format: 'uni-hotspot-snapshot', formatVersion: 1, createdAt: 1, schemaVersion: from }));
    const r = await a.api<{ schemaVersion: number }>('POST', `/api/backups/${id}/restore`, { confirm: true });
    expect(r.status).toBe(200);
    expect(r.data.schemaVersion).toBe(from);
    await a.close();
    const b = await app(dir);
    const v = (b.hotspot.services.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(v).toBe(SCHEMA_VERSION);
    expect((b.hotspot.services.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    const migBackups = fs.readdirSync(path.join(dir, 'backups')).filter((f) => /^hotspot-v\d+-/.test(f));
    expect(migBackups.length).toBe(from < SCHEMA_VERSION ? 1 : 0);
    expect(count(b, 'sources')).toBeGreaterThan(0);
  });
});

describe('Aufbewahrung, Zielordner, Automatik', () => {
  it('nur automatische Sicherungen werden ausgedünnt (N), manuelle bleiben', async () => {
    const a = await app();
    await a.api('PUT', '/api/settings', { backupKeep: 2 });
    const svc = a.hotspot.services.backup;
    await a.api('POST', '/api/backups');
    for (let i = 0; i < 4; i++) await svc.create('auto');
    const items = (await a.api<Backups>('GET', '/api/backups')).data.items;
    expect(items.filter((x) => x.reason === 'auto')).toHaveLength(2);
    expect(items.filter((x) => x.reason === 'manual')).toHaveLength(1);
  });

  it('wählbarer Zielordner (absolut), relativer Pfad abgelehnt; gleichzeitige Aufträge laufen nacheinander', async () => {
    const a = await app();
    expect((await a.api<{ error: string }>('PUT', '/api/settings', { backupDir: 'relativ/pfad' })).data.error).toBe('invalid_setting');
    const target = tmpDir('bktarget');
    await a.api('PUT', '/api/settings', { backupDir: target });
    const [x, y] = await Promise.all([a.api<{ snapshot: { id: string } }>('POST', '/api/backups'), a.api<{ snapshot: { id: string } }>('POST', '/api/backups')]);
    expect(x.data.snapshot.id).not.toBe(y.data.snapshot.id);
    expect(fs.readdirSync(target).filter((f) => f.startsWith('snapshot-'))).toHaveLength(2);
    expect((await a.api<Backups>('GET', '/api/backups')).data.dir).toBe(target);
  });

  it('automatische Sicherung nur, wenn fällig; Intervall 0 = aus', async () => {
    const a = await app();
    const svc = a.hotspot.services.backup;
    expect(svc.autoTick()).toBe(true);
    await waitFor(() => svc.list().some((s) => s.reason === 'auto'), { message: 'auto' });
    expect(svc.autoTick()).toBe(false); // gerade erst gesichert
    await a.api('PUT', '/api/settings', { backupIntervalHours: 0 });
    expect(svc.autoTick()).toBe(false);
  });

  it('Löschen einer Sicherung per ID; fremde Namen werden abgelehnt', async () => {
    const a = await app();
    const id = (await a.api<{ snapshot: { id: string } }>('POST', '/api/backups')).data.snapshot.id;
    expect((await a.api('DELETE', '/api/backups/..%2F..%2Fhotspot.sqlite')).status).toBeGreaterThanOrEqual(400);
    expect((await a.api<Backups>('DELETE', `/api/backups/${id}`)).data.items).toEqual([]);
    expect(fs.existsSync(path.join(a.dataDir, 'hotspot.sqlite'))).toBe(true);
  });
});

describe('Neustart im selben Prozess (Browser-Modus, server/main.ts)', () => {
  it('Wiederherstellung über die API -> Server startet auf demselben Port mit wiederhergestellten Daten', async () => {
    const dir = tmpDir('bkproc');
    const port = 4700 + (process.pid % 200);
    const token = 'r'.repeat(64);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'server', 'main.ts')], {
      env: { ...process.env, HOTSPOT_DATA_DIR: dir, HOTSPOT_PORT: String(port), HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_TOKEN: token },
      stdio: 'ignore',
    });
    try {
      const api = async (method: string, p: string, body?: unknown) => {
        const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-hotspot-token': token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return (await r.json()) as Record<string, unknown>;
      };
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { 'x-hotspot-token': token } }).then((r) => r.ok).catch(() => false)), { message: 'start' });
      await api('POST', '/api/subjects', { name: 'Vorher', color: '#39e6ff' });
      const snap = (await api('POST', '/api/backups')).snapshot as { id: string };
      await api('POST', '/api/subjects', { name: 'Nachher', color: '#39e6ff' });
      const r = await api('POST', `/api/backups/${snap.id}/restore`, { confirm: true });
      expect(r.restarting).toBe(true);
      const names = await waitFor(
        async () => {
          const boot = await api('GET', '/api/bootstrap').catch(() => null);
          const restored = boot?.restored as { ok: boolean } | null | undefined;
          return restored?.ok ? (boot!.subjects as { name: string }[]).map((s) => s.name) : null;
        },
        { message: 'neu gestartet' },
      );
      expect(names).toEqual(['Vorher']);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  });
});
