import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { migrate, openDb, SCHEMA_VERSION, SchemaTooNewError } from '../server/db.ts';
import { tmpDir } from './helpers.ts';

const FIXTURE = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'phase1.sqlite');

function phase1Copy(): { dir: string; file: string } {
  const dir = tmpDir('mig');
  const file = path.join(dir, 'hotspot.sqlite');
  fs.copyFileSync(FIXTURE, file);
  return { dir, file };
}

const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

describe('DB-Migration von einer echten Phase-1-Datenbank', () => {
  it('Fixture ist wirklich Schema v2 (Phase 1)', () => {
    const db = new DatabaseSync(FIXTURE, { readOnly: true });
    expect(version(db)).toBe(2);
    db.close();
  });

  it('migriert auf die aktuelle Version, legt vorher ein Backup an und behält alle Daten', () => {
    const { dir, file } = phase1Copy();
    const db = openDb(file);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    // Daten unverändert
    expect(db.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT count(*) AS n FROM embeddings').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'language'").get()).toEqual({ value: '"en"' });
    expect(db.prepare('SELECT count(*) AS n FROM chat_messages').get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'entropie'").get()).toEqual({ n: 1 });
    // neue Spalte/Tabellen
    expect(db.prepare('SELECT origin FROM chunks WHERE id = 1').get()).toEqual({ origin: null });
    expect(db.prepare('SELECT count(*) AS n FROM media_jobs').get()).toEqual({ n: 0 });
    // in Phase 1 nur gespeicherte Medien werden jetzt verarbeitet
    expect(db.prepare("SELECT status FROM sources WHERE kind IN ('image', 'audio') ORDER BY id").all()).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    db.close();

    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^hotspot-v2-\d{8}-\d{6}\.sqlite$/);
    const bak = new DatabaseSync(path.join(dir, 'backups', backups[0]!), { readOnly: true });
    expect(version(bak)).toBe(2);
    expect(bak.prepare('SELECT count(*) AS n FROM chunks').get()).toEqual({ n: 2 });
    expect(bak.prepare("SELECT status FROM sources WHERE kind = 'image'").get()).toEqual({ status: 'unsupported' });
    bak.close();
  });

  it('K7: migrierte TIFF-Datei bekommt den Formathinweis (nicht "beschädigt"/Fehler)', async () => {
    const { dir } = phase1Copy();
    const { startTestApp, waitForSource } = await import('./helpers.ts');
    const app = await startTestApp({ dataDir: dir });
    try {
      const tiff = app.hotspot.services.db.prepare("SELECT id FROM sources WHERE name = 'Scan.tiff'").get() as { id: number };
      const s = await waitForSource(app, tiff.id);
      expect([s.status, s.statusDetail]).toEqual(['unsupported', 'image_format_unsupported']);
    } finally {
      await app.close();
    }
  });

  it('idempotent: erneutes Öffnen migriert nicht erneut und legt kein weiteres Backup an', () => {
    const { dir, file } = phase1Copy();
    openDb(file).close();
    const db = openDb(file);
    expect(version(db)).toBe(SCHEMA_VERSION);
    db.close();
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(1);
  });

  it('neue (leere) Datenbank: kein Backup', () => {
    const dir = tmpDir('mignew');
    openDb(path.join(dir, 'hotspot.sqlite')).close();
    expect(fs.existsSync(path.join(dir, 'backups'))).toBe(false);
  });

  it('fehlerhafte Migration wird komplett zurückgerollt (Version und Schema unverändert)', () => {
    const { file } = phase1Copy();
    const db = new DatabaseSync(file);
    const good = ['SELECT 1', 'SELECT 1']; // v1, v2 gelten als erledigt
    expect(() => migrate(db, file, [...good, 'CREATE TABLE halb(a); INSERT INTO gibtsnicht VALUES (1);'])).toThrow();
    expect(version(db)).toBe(2);
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'halb'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('DB einer neueren App-Version wird nicht angefasst (klarer Fehler statt Zerstörung)', () => {
    const { file } = phase1Copy();
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => openDb(file)).toThrow(SchemaTooNewError);
    const check = new DatabaseSync(file, { readOnly: true });
    expect(version(check)).toBe(99);
    check.close();
  });

  it('es bleiben höchstens 3 Backups', () => {
    const { dir, file } = phase1Copy();
    for (let i = 0; i < 5; i++) {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA user_version = 2');
      migrate(db, file, ['SELECT 1', 'SELECT 1', 'SELECT 1']);
      db.close();
    }
    expect(fs.readdirSync(path.join(dir, 'backups'))).toHaveLength(3);
  });
});
