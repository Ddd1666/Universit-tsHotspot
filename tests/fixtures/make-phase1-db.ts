// Einmalig mit dem Phase-1-Code (Stand 0e6d6b0) ausgeführt, um tests/fixtures/phase1.sqlite zu erzeugen:
//   node tests/fixtures/make-phase1-db.ts
// Die erzeugte Datei ist eingecheckt; das Skript dokumentiert nur ihre Herkunft.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../server/db.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phase1.sqlite');
fs.rmSync(out, { force: true });
const db = openDb(out);
db.exec(`INSERT INTO subjects(name, color, created_at) VALUES ('Physik', '#39e6ff', 1);
INSERT INTO sources(subject_id, sha256, name, size, mime, kind, status, chunk_count, imported_at, processed_at)
  VALUES (1, '${'a'.repeat(64)}', 'Skript.pdf', 1000, 'application/pdf', 'pdf', 'ready', 2, 1, 2),
         (1, '${'b'.repeat(64)}', 'Tafelbild.png', 500, 'image/png', 'image', 'unsupported', 0, 1, NULL),
         (NULL, '${'c'.repeat(64)}', 'Vorlesung.mp3', 900, 'audio/mpeg', 'audio', 'unsupported', 0, 1, NULL);
UPDATE sources SET status_detail = 'phase2_media' WHERE kind IN ('image', 'audio');
INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, token_est, embed_state)
  VALUES (1, 0, 'Der erste Hauptsatz beschreibt die Energieerhaltung.', NULL, 'page', 1, 1, 18, 1),
         (1, 1, 'Entropie ist ein Maß für Mikrozustände.', 'Kapitel 2', 'page', 2, 2, 14, 0);
INSERT INTO embeddings(chunk_id, source_id, vec) VALUES (1, 1, zeroblob(16));
INSERT INTO meta(key, value) VALUES ('vector_model', 'nomic-embed-text'), ('vector_dim', '4');
INSERT INTO settings(key, value) VALUES ('language', '"en"'), ('numCtx', '4096');
INSERT INTO chat_sessions(title, scope, created_at, updated_at) VALUES ('Thermo', '{"mode":"all"}', 1, 2);
INSERT INTO chat_messages(session_id, role, content, citations, status, created_at) VALUES (1, 'user', 'Was ist Entropie?', NULL, 'done', 1),
  (1, 'assistant', 'Ein Maß [1]', '[]', 'done', 2);`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('PRAGMA journal_mode = DELETE');
db.close();
console.log(out, fs.statSync(out).size);
