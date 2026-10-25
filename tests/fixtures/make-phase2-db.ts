// Einmalig mit dem Phase-2-Code (Stand 00175d0, Schema v3) ausgeführt, um tests/fixtures/phase2.sqlite zu erzeugen:
//   node tests/fixtures/make-phase2-db.ts
// Die erzeugte Datei ist eingecheckt; das Skript dokumentiert nur ihre Herkunft.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../server/db.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phase2.sqlite');
fs.rmSync(out, { force: true });
const db = openDb(out);
db.exec(`INSERT INTO subjects(name, color, created_at) VALUES ('Physik', '#39e6ff', 1), ('Mathe', '#b56cff', 2);
INSERT INTO sources(subject_id, sha256, name, size, mime, kind, status, chunk_count, page_count, imported_at, processed_at)
  VALUES (1, '${'a'.repeat(64)}', 'Skript.pdf', 1000, 'application/pdf', 'pdf', 'ready', 3, 2, 1, 2),
         (1, '${'b'.repeat(64)}', 'Tafelbild.png', 500, 'image/png', 'image', 'ready', 2, NULL, 1, 2),
         (2, '${'c'.repeat(64)}', 'Vorlesung.mp3', 900, 'audio/mpeg', 'audio', 'media', 0, NULL, 1, NULL);
INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, token_est, embed_state, origin)
  VALUES (1, 0, 'Der erste Hauptsatz beschreibt die Energieerhaltung.', 'Kapitel 1', 'page', 1, 1, 18, 1, NULL),
         (1, 1, 'Entropie ist ein Maß für Mikrozustände.', 'Kapitel 2', 'page', 2, 2, 14, 1, NULL),
         (1, 2, 'Gescannte Seite: Carnot-Wirkungsgrad.', NULL, 'page', 2, 2, 12, 0, 'ocr'),
         (2, 0, 'S = k ln W', NULL, NULL, NULL, NULL, 4, 1, 'ocr'),
         (2, 1, 'Eine Tafel mit der Boltzmann-Formel.', NULL, NULL, NULL, NULL, 10, 1, 'vision');
INSERT INTO embeddings(chunk_id, source_id, vec) VALUES (1, 1, zeroblob(16)), (2, 1, zeroblob(16)), (4, 2, zeroblob(16)), (5, 2, zeroblob(16));
INSERT INTO meta(key, value) VALUES ('vector_model', 'nomic-embed-text'), ('vector_dim', '4');
INSERT INTO settings(key, value) VALUES ('language', '"en"'), ('whisperModel', '"medium-q5_0"');
INSERT INTO media_jobs(source_id, kind, state, progress, total, params, created_at, updated_at)
  VALUES (3, 'audio', 'running', 600, 1800, '{"model":"small","lang":"auto","probed":true,"duration":1800,"hasAudio":true}', 1, 2);
INSERT INTO media_parts(job_id, idx, data) VALUES (1, 0, '[{"s":0,"e":5,"t":"Hallo"}]');
INSERT INTO chat_sessions(title, scope, created_at, updated_at) VALUES ('Thermo', '{"mode":"subjects","ids":[1]}', 1, 2);
INSERT INTO chat_messages(session_id, role, content, citations, status, created_at) VALUES (1, 'user', 'Was ist Entropie?', NULL, 'done', 1),
  (1, 'assistant', 'Ein Maß [1]', '[{"n":1,"chunkId":2,"sourceId":1,"sourceName":"Skript.pdf","snippet":"Entropie"}]', 'done', 2);`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('PRAGMA journal_mode = DELETE');
db.close();
console.log(out, fs.statSync(out).size);
