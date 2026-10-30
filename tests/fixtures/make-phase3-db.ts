// Einmalig mit dem Phase-3-Code (Stand 4049bf9, Schema v4) ausgeführt, um tests/fixtures/phase3.sqlite zu erzeugen:
//   node tests/fixtures/make-phase3-db.ts
// Die erzeugte Datei ist eingecheckt; das Skript dokumentiert nur ihre Herkunft.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../server/db.ts';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'phase3.sqlite');
fs.rmSync(out, { force: true });
const db = openDb(out);
db.exec(`INSERT INTO subjects(name, color, created_at) VALUES ('Physik', '#39e6ff', 1), ('Mathe', '#b56cff', 2);
INSERT INTO sources(subject_id, sha256, name, size, mime, kind, status, chunk_count, page_count, imported_at, processed_at)
  VALUES (1, '${'a'.repeat(64)}', 'Skript.pdf', 1000, 'application/pdf', 'pdf', 'ready', 2, 2, 1, 2),
         (2, '${'d'.repeat(64)}', 'Analysis.md', 300, 'text/markdown', 'markdown', 'ready', 1, NULL, 1, 2);
INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, token_est, embed_state, origin)
  VALUES (1, 0, 'Der erste Hauptsatz beschreibt die Energieerhaltung.', 'Kapitel 1', 'page', 1, 1, 18, 1, NULL),
         (1, 1, 'Entropie ist ein Maß für Mikrozustände.', 'Kapitel 2', 'page', 2, 2, 14, 1, NULL),
         (2, 0, 'Eine Folge konvergiert, wenn sie einen Grenzwert hat.', 'Folgen', 'section', NULL, NULL, 16, 1, NULL);
INSERT INTO embeddings(chunk_id, source_id, vec) VALUES (1, 1, zeroblob(16)), (2, 1, zeroblob(16)), (3, 2, zeroblob(16));
INSERT INTO meta(key, value) VALUES ('vector_model', 'nomic-embed-text'), ('vector_dim', '4');
INSERT INTO settings(key, value) VALUES ('language', '"de"'), ('chatModel', '"gemma3:4b"');
INSERT INTO chat_sessions(title, scope, created_at, updated_at) VALUES ('Thermo', '{"mode":"subjects","ids":[1]}', 1, 2);
INSERT INTO chat_messages(session_id, role, content, citations, status, created_at) VALUES (1, 'user', 'Was ist Entropie?', NULL, 'done', 1),
  (1, 'assistant', 'Ein Maß [1]', '[{"n":1,"chunkId":2,"sourceId":1,"sourceName":"Skript.pdf","snippet":"Entropie"}]', 'done', 2);
INSERT INTO notes(title, body, level, scope, citations, subject_id, ai, edited, created_at, updated_at)
  VALUES ('Thermo – Gliederung', '- Energieerhaltung [1]\n- Entropie [2]', 'outline', '{"kind":"subject","id":1}',
    '[{"n":1,"chunkId":1,"sourceId":1,"sourceName":"Skript.pdf","loc":{"k":"page","s":1,"e":1,"l":null},"heading":"Kapitel 1"},{"n":2,"chunkId":2,"sourceId":1,"sourceName":"Skript.pdf","loc":{"k":"page","s":2,"e":2,"l":null},"heading":"Kapitel 2"}]',
    1, 1, 0, 3, 3);
INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, chunk_id, source_name, reps, ease, interval_days, lapses, due, last_review, created_at, updated_at)
  VALUES ('qa', 'Was ist Entropie?', 'Ein Maß für Mikrozustände', 'active', 1, 1, 1, 2, 'Skript.pdf', 2, 2.6, 6, 0, 1000000000000, 900000000000, 3, 3),
         ('cloze', 'Eine {{Folge}} konvergiert', 'Folge', 'draft', 1, 2, 2, 3, 'Analysis.md', 0, 2.5, 0, 0, NULL, NULL, 3, 3);
INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (1, 3, 800000000000, 1, 2.5), (1, 4, 900000000000, 6, 2.6);
INSERT INTO quiz_questions(type, question, options, answer, explanation, topic, fingerprint, subject_id, source_id, chunk_id, source_name, created_at)
  VALUES ('mc', 'Was beschreibt der erste Hauptsatz?', '["Energieerhaltung","Entropie","Impuls"]', 'Energieerhaltung', 'S. 1', 'Hauptsätze', 'fp-1', 1, 1, 1, 'Skript.pdf', 4);
INSERT INTO quiz_sessions(mode, scope, question_ids, started_at, finished_at) VALUES ('practice', '{}', '[1]', 5, 6);
INSERT INTO quiz_attempts(question_id, session_id, answer, score, created_at) VALUES (1, 1, 'Energieerhaltung', 1, 6);
INSERT INTO concepts(name, norm, created_at) VALUES ('Entropie', 'entropi', 7), ('Energie', 'energi', 7);
INSERT INTO concept_sources(concept_id, source_id, chunk_id) VALUES (1, 1, 2), (2, 1, 1);
INSERT INTO concept_edges(a, b, label, source_id) VALUES (1, 2, 'hängt zusammen mit', 1);
INSERT INTO learn_jobs(kind, state, title, params, progress, total, created_at, updated_at) VALUES ('summary', 'done', 'Thermo', '{}', 3, 3, 3, 3);`);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('PRAGMA journal_mode = DELETE');
db.close();
console.log(out, fs.statSync(out).size);
