import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/**
 * SQLite über das in Node eingebaute `node:sqlite` (keine nativen npm-Module nötig ->
 * kein Compiler/Prebuild auf Windows, funktioniert identisch in Node und Electron).
 * Alle Queries sind parametrisiert.
 */
export type DB = DatabaseSync;
export type Param = SQLInputValue;

const MIGRATIONS: string[] = [
  // v1 – Grundschema Phase 1
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE subjects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
    parent_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    sha256 TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    rel_path TEXT,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    status_detail TEXT,
    batch_id TEXT,
    page_count INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    imported_at INTEGER NOT NULL,
    processed_at INTEGER
  );
  CREATE INDEX sources_subject ON sources(subject_id);
  CREATE INDEX sources_status ON sources(status);
  CREATE INDEX sources_parent ON sources(parent_id);

  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    heading TEXT,
    loc_kind TEXT,
    loc_start INTEGER,
    loc_end INTEGER,
    loc_label TEXT,
    token_est INTEGER NOT NULL,
    embed_state INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX chunks_source ON chunks(source_id, ord);
  CREATE INDEX chunks_embed_state ON chunks(embed_state);

  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    text, heading,
    content='chunks', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, coalesce(new.heading, ''));
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, coalesce(old.heading, ''));
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE OF text, heading ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, coalesce(old.heading, ''));
    INSERT INTO chunks_fts(rowid, text, heading) VALUES (new.id, new.text, coalesce(new.heading, ''));
  END;

  -- Vektoren des aktiven Index (Modell + Dimension stehen in meta: vector_model / vector_dim)
  CREATE TABLE embeddings (
    chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE INDEX embeddings_source ON embeddings(source_id);

  CREATE TABLE chat_sessions (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    title_locked INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    scope TEXT NOT NULL DEFAULT '{"mode":"all"}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX chat_sessions_updated ON chat_sessions(updated_at);

  CREATE TABLE chat_messages (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    thinking TEXT,
    citations TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX chat_messages_session ON chat_messages(session_id, id);
  `,
];

export function openDb(file: string): DB {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    tx(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
    version++;
  }
}

let savepointCounter = 0;
/** Transaktion (verschachtelbar über SAVEPOINTs). */
export function tx<T>(db: DB, fn: () => T): T {
  const name = `sp_${++savepointCounter}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw err;
  }
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DB, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  else db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Hilfsfunktion: Liste als JSON-Parameter für `IN (SELECT value FROM json_each(?))`. */
export function jsonList(values: readonly (number | string)[]): string {
  return JSON.stringify(values);
}
