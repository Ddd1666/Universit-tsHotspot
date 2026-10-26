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

  it('Phase-2-Datenbank (Schema v3): Backup, Lern-Tabellen leer angelegt, Medien-Jobs/KI-Abschnitte/Chats unverändert', () => {
    const dir = tmpDir('mig2');
    const file = path.join(dir, 'hotspot.sqlite');
    fs.copyFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'phase2.sqlite'), file);
    const raw = new DatabaseSync(file, { readOnly: true });
    expect(version(raw)).toBe(3);
    raw.close();
    const db = openDb(file);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    expect((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM chunks WHERE origin IS NOT NULL').get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'carnot'").get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT state, progress FROM media_jobs').get()).toEqual({ state: 'running', progress: 600 });
    expect(db.prepare('SELECT count(*) AS n FROM media_parts').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'whisperModel'").get()).toEqual({ value: '"medium-q5_0"' });
    expect(db.prepare('SELECT count(*) AS n FROM chat_messages').get()).toEqual({ n: 2 });
    for (const t of ['learn_jobs', 'learn_cache', 'notes', 'cards', 'reviews', 'quiz_questions', 'quiz_sessions', 'quiz_attempts', 'concepts', 'concept_sources', 'concept_edges']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get(), t).toEqual({ n: 0 });
    }
    // Korrekturrunde 1: Kantenkorrektur (edited) und eine Antwort je Frage und Sitzung (UNIQUE) sind Teil von v4
    expect((db.prepare('PRAGMA table_info(concept_edges)').all() as { name: string }[]).some((c) => c.name === 'edited')).toBe(true);
    db.exec("INSERT INTO quiz_questions(type, question, answer, fingerprint, created_at) VALUES ('tf', 'F?', 'true', 'fp', 1)");
    db.exec("INSERT INTO quiz_sessions(mode, scope, question_ids, started_at) VALUES ('practice', '{}', '[1]', 1)");
    db.exec("INSERT INTO quiz_attempts(question_id, session_id, answer, score, created_at) VALUES (1, 1, 'true', 1, 1)");
    expect(() => db.exec("INSERT INTO quiz_attempts(question_id, session_id, answer, score, created_at) VALUES (1, 1, 'false', 0, 2)")).toThrow(/UNIQUE/);
    // Löschverhalten greift auch in der migrierten DB (FK + Trigger)
    db.exec("INSERT INTO cards(type, front, back, status, source_id, source_name, created_at, updated_at) VALUES ('qa', 'F', 'B', 'active', 1, 'Skript.pdf', 1, 1)");
    db.exec("INSERT INTO concepts(name, norm, created_at) VALUES ('Entropie', 'entropi', 1)");
    db.exec('INSERT INTO concept_sources(concept_id, source_id) VALUES (1, 1)');
    db.exec('DELETE FROM sources WHERE id = 1');
    expect(db.prepare('SELECT source_id, source_name FROM cards').get()).toEqual({ source_id: null, source_name: 'Skript.pdf' });
    expect(db.prepare('SELECT count(*) AS n FROM concepts').get()).toEqual({ n: 0 });
    db.close();
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^hotspot-v3-\d{8}-\d{6}\.sqlite$/);
    const bak = new DatabaseSync(path.join(dir, 'backups', backups[0]!), { readOnly: true });
    expect(version(bak)).toBe(3);
    expect(bak.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'cards'").get()).toEqual({ n: 0 });
    bak.close();
  });

  it('Phase-2-Datenbank startet als App: Lern-API leer, Chats erhalten', async () => {
    const dir = tmpDir('mig2app');
    fs.copyFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'phase2.sqlite'), path.join(dir, 'hotspot.sqlite'));
    const { startTestApp } = await import('./helpers.ts');
    const app = await startTestApp({ dataDir: dir });
    try {
      expect((await app.api<{ items: unknown[] }>('GET', '/api/cards')).data.items).toEqual([]);
      expect((await app.api<{ due: number }>('GET', '/api/srs/due')).data.due).toBe(0);
      expect((await app.api<{ nodes: unknown[] }>('GET', '/api/graph')).data.nodes).toEqual([]);
      expect((await app.api<{ jobs: unknown[] }>('GET', '/api/learn/jobs')).data.jobs).toEqual([]);
      const chats = (await app.api<{ title: string }[]>('GET', '/api/chats')).data;
      expect(chats.map((c) => c.title)).toEqual(['Thermo']);
    } finally {
      await app.close();
    }
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
