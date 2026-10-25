import { jsonList, tx, type DB } from '../db.ts';
import { HttpError } from '../library.ts';
import { estimateTokens } from '../ingest/chunker.ts';
import type { SearchHit } from '../search/hybrid.ts';
import { CLOZE_RE, callValidated, GRADE_SCHEMA, gradeMessages, parseGrade, type CallOpts, type Grade } from './prompts.ts';
import { review, type Rating } from './srs.ts';
import { cleanText, contentTokens, documentsBlock, type LChunk, type Loc, type Ref } from './text.ts';

/**
 * Datenzugriff der Lernmodi (Notizen, Karten + Wiederholung, Quiz, Graph). Alles parametrisiert; jede neue Abfrage
 * ist per EXPLAIN QUERY PLAN geprüft und mit 2 000 Quellen / 40 000 Abschnitten gemessen (scripts/bench-learn.ts).
 */

export const LIMITS_TEXT = { noteTitle: 200, noteBody: 200_000, cardFront: 2000, cardBack: 4000, listMax: 500 };
const DAY = 86_400_000;

function parse<T>(s: string | null, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function existingSources(db: DB, ids: (number | null)[]): Set<number> {
  const list = [...new Set(ids.filter((x): x is number => x !== null))];
  if (!list.length) return new Set();
  return new Set((db.prepare('SELECT id FROM sources WHERE id IN (SELECT value FROM json_each(?))').all(jsonList(list)) as { id: number }[]).map((r) => r.id));
}

/** Positionsangabe für Export/Hinweise (Oberfläche formatiert selbst). */
export function locText(loc: Loc | null, lang: 'de' | 'en'): string {
  if (!loc || loc.s === null) return '';
  const r = loc.e !== null && loc.e !== loc.s ? `${loc.s}–${loc.e}` : `${loc.s}`;
  const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  switch (loc.k) {
    case 'page':
      return `${lang === 'de' ? 'S.' : 'p.'} ${r}`;
    case 'slide':
      return `${lang === 'de' ? 'Folie' : 'slide'} ${r}`;
    case 'time':
      return `${clock(loc.s)}–${clock(loc.e ?? loc.s)}`;
    case 'sheet':
      return `${lang === 'de' ? 'Blatt' : 'sheet'} ${loc.l ?? ''}`;
    default:
      return loc.l ?? r;
  }
}

/* ============================================================ Notizen */

export interface NoteDTO {
  id: number;
  title: string;
  body: string;
  level: string | null;
  scope: Record<string, unknown>;
  citations: Ref[];
  subjectId: number | null;
  ai: boolean;
  edited: boolean;
  createdAt: number;
  updatedAt: number;
}

interface NoteRow {
  id: number;
  title: string;
  body: string;
  level: string | null;
  scope: string;
  citations: string;
  subject_id: number | null;
  ai: number;
  edited: number;
  created_at: number;
  updated_at: number;
}

export function listNotes(db: DB, subjectId?: number): Omit<NoteDTO, 'body' | 'citations' | 'scope'>[] {
  const rows = db
    .prepare(`SELECT id, title, level, subject_id, ai, edited, created_at, updated_at FROM notes ${subjectId ? 'WHERE subject_id = ?' : ''} ORDER BY updated_at DESC LIMIT 1000`)
    .all(...(subjectId ? [subjectId] : [])) as unknown as NoteRow[];
  return rows.map((r) => ({ id: r.id, title: r.title, level: r.level, subjectId: r.subject_id, ai: !!r.ai, edited: !!r.edited, createdAt: r.created_at, updatedAt: r.updated_at }));
}

export function getNote(db: DB, id: number): NoteDTO {
  const r = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
  if (!r) throw new HttpError(404, 'not_found', 'Notiz nicht gefunden');
  const citations = parse<Ref[]>(r.citations, []);
  const alive = existingSources(db, citations.map((c) => c.sourceId));
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    level: r.level,
    scope: parse(r.scope, {}),
    // gelöschte Quelle: Verweis bleibt mit Hinweis sichtbar (Text der Notiz gehört dem Nutzer)
    citations: citations.map((c) => ({ ...c, deleted: c.sourceId !== null && !alive.has(c.sourceId) })),
    subjectId: r.subject_id,
    ai: !!r.ai,
    edited: !!r.edited,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function createNote(db: DB, input: { title: string; body: string; subjectId?: number | null }): NoteDTO {
  const title = cleanText(input.title, LIMITS_TEXT.noteTitle);
  if (!title) throw new HttpError(400, 'invalid_title', 'Titel fehlt');
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO notes(title, body, level, scope, subject_id, ai, created_at, updated_at) VALUES (?, ?, NULL, '{}', (SELECT id FROM subjects WHERE id = ?), 0, ?, ?)")
      .run(title, input.body.slice(0, LIMITS_TEXT.noteBody), input.subjectId ?? null, now, now).lastInsertRowid,
  );
  return getNote(db, id);
}

export function updateNote(db: DB, id: number, patch: { title?: string; body?: string }): NoteDTO {
  getNote(db, id);
  if (patch.title !== undefined) {
    const t = cleanText(patch.title, LIMITS_TEXT.noteTitle);
    if (!t) throw new HttpError(400, 'invalid_title', 'Titel fehlt');
    db.prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?').run(t, Date.now(), id);
  }
  if (patch.body !== undefined) db.prepare('UPDATE notes SET body = ?, edited = 1, updated_at = ? WHERE id = ?').run(patch.body.slice(0, LIMITS_TEXT.noteBody), Date.now(), id);
  return getNote(db, id);
}

export function deleteNote(db: DB, id: number): void {
  if (!Number(db.prepare('DELETE FROM notes WHERE id = ?').run(id).changes)) throw new HttpError(404, 'not_found', 'Notiz nicht gefunden');
}

const LEVEL_NAME: Record<string, Record<'de' | 'en', string>> = {
  tldr: { de: 'TL;DR', en: 'TL;DR' },
  outline: { de: 'Gliederung', en: 'Outline' },
  detailed: { de: 'Ausführlich', en: 'Detailed' },
  cheatsheet: { de: 'Klausur-Spickzettel', en: 'Exam cheat sheet' },
};

/** Markdown-Export: Text + KI-Kennzeichnung + Quellenliste (gelöschte Quellen mit Hinweis). */
export function exportNote(db: DB, id: number, lang: 'de' | 'en'): { name: string; markdown: string } {
  const n = getNote(db, id);
  const de = lang === 'de';
  const lines = [`# ${n.title}`, ''];
  if (n.ai) {
    const lvl = n.level ? LEVEL_NAME[n.level]?.[lang] : null;
    lines.push(`> ${de ? 'KI-generiert' : 'AI-generated'} (Uni-Hotspot${lvl ? `, ${lvl}` : ''})${n.edited ? (de ? ', bearbeitet' : ', edited') : ''} – ${de ? 'kann Fehler enthalten.' : 'may contain mistakes.'}`, '');
  }
  lines.push(n.body.trim(), '');
  if (n.citations.length) {
    lines.push(`## ${de ? 'Quellen' : 'Sources'}`, '');
    for (const c of n.citations) {
      const loc = locText(c.loc, lang);
      lines.push(`${c.n}. ${c.sourceName}${loc ? `, ${loc}` : ''}${c.heading ? ` – ${c.heading}` : ''}${c.deleted ? (de ? ' (Quelle gelöscht)' : ' (source deleted)') : ''}`);
    }
  }
  // eslint-disable-next-line no-control-regex
  return { name: `${n.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'note'}.md`, markdown: lines.join('\n') + '\n' };
}

/* ============================================================ Karten + Wiederholung */

export type CardType = 'qa' | 'cloze' | 'image';
export type CardStatus = 'draft' | 'active' | 'suspended';

export interface CardDTO {
  id: number;
  type: CardType;
  front: string;
  back: string;
  status: CardStatus;
  ai: boolean;
  subjectId: number | null;
  sourceId: number | null;
  sourceName: string | null;
  sourceKind: string | null;
  /** Quelle wurde gelöscht – Karte behält ihren Text, verliert den Link */
  sourceDeleted: boolean;
  chunkId: number | null;
  loc: Loc | null;
  chat: { id: number; title: string } | null;
  reps: number;
  ease: number;
  intervalDays: number;
  lapses: number;
  due: number | null;
  lastReview: number | null;
  reviewCount: number;
  createdAt: number;
  updatedAt: number;
}

const CARD_SELECT = `SELECT c.*, s.name AS live_name, s.kind AS source_kind, ch.loc_kind, ch.loc_start, ch.loc_end, ch.loc_label,
  (SELECT count(*) FROM reviews r WHERE r.card_id = c.id) AS review_count
  FROM cards c LEFT JOIN sources s ON s.id = c.source_id LEFT JOIN chunks ch ON ch.id = c.chunk_id`;

interface CardRow {
  id: number;
  type: CardType;
  front: string;
  back: string;
  status: CardStatus;
  ai: number;
  subject_id: number | null;
  source_id: number | null;
  chunk_id: number | null;
  source_name: string | null;
  loc: string | null;
  reps: number;
  ease: number;
  interval_days: number;
  lapses: number;
  due: number | null;
  last_review: number | null;
  created_at: number;
  updated_at: number;
  live_name: string | null;
  source_kind: string | null;
  loc_kind: string | null;
  loc_start: number | null;
  loc_end: number | null;
  loc_label: string | null;
  review_count: number;
}

function toCard(r: CardRow): CardDTO {
  const snap = parse<(Loc & { chat?: number; t?: string }) | null>(r.loc, null);
  const chat = snap && typeof snap.chat === 'number' ? { id: snap.chat, title: String(snap.t ?? '') } : null;
  return {
    id: r.id,
    type: r.type,
    front: r.front,
    back: r.back,
    status: r.status,
    ai: !!r.ai,
    subjectId: r.subject_id,
    sourceId: r.source_id,
    sourceName: r.live_name ?? r.source_name,
    sourceKind: r.source_kind,
    sourceDeleted: r.source_id === null && r.source_name !== null,
    chunkId: r.chunk_id,
    loc: r.loc_kind ? { k: r.loc_kind, s: r.loc_start, e: r.loc_end, l: r.loc_label } : chat ? null : snap,
    chat,
    reps: r.reps,
    ease: r.ease,
    intervalDays: r.interval_days,
    lapses: r.lapses,
    due: r.due,
    lastReview: r.last_review,
    reviewCount: r.review_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getCard(db: DB, id: number): CardDTO {
  const r = db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(id) as CardRow | undefined;
  if (!r) throw new HttpError(404, 'not_found', 'Karte nicht gefunden');
  return toCard(r);
}

export interface CardFilter {
  status?: CardStatus;
  subjectId?: number;
  sourceId?: number;
  jobId?: number;
  q?: string;
  limit?: number;
}

function cardWhere(f: CardFilter): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.status) {
    where.push('c.status = ?');
    params.push(f.status);
  }
  if (f.subjectId) {
    where.push('c.subject_id = ?');
    params.push(f.subjectId);
  }
  if (f.sourceId) {
    where.push('c.source_id = ?');
    params.push(f.sourceId);
  }
  if (f.jobId) {
    where.push('c.job_id = ?');
    params.push(f.jobId);
  }
  if (f.q) {
    const like = `%${f.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    where.push("(c.front LIKE ? ESCAPE '\\' OR c.back LIKE ? ESCAPE '\\')");
    params.push(like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

export function listCards(db: DB, f: CardFilter): { items: CardDTO[]; total: number } {
  const { sql, params } = cardWhere(f);
  const limit = Math.min(f.limit ?? 200, LIMITS_TEXT.listMax);
  const items = (db.prepare(`${CARD_SELECT} ${sql} ORDER BY c.id DESC LIMIT ?`).all(...params, limit) as unknown as CardRow[]).map(toCard);
  const total = items.length < limit ? items.length : (db.prepare(`SELECT count(*) AS n FROM cards c ${sql}`).get(...params) as { n: number }).n;
  return { items, total };
}

function validateCard(db: DB, c: { type: CardType; front: string; back: string; sourceId: number | null }): void {
  if (!c.front.trim()) throw new HttpError(400, 'card_invalid', 'Vorderseite fehlt');
  if (c.type === 'qa' && !c.back.trim()) throw new HttpError(400, 'card_invalid', 'Rückseite fehlt');
  if (c.type === 'cloze' && !new RegExp(CLOZE_RE.source).test(c.front)) throw new HttpError(400, 'card_cloze_missing', 'Lückentext braucht {{…}}');
  if (c.type === 'image') {
    const src = c.sourceId === null ? undefined : (db.prepare('SELECT kind FROM sources WHERE id = ?').get(c.sourceId) as { kind: string } | undefined);
    if (src?.kind !== 'image') throw new HttpError(400, 'card_image_missing', 'Bildkarte braucht ein Bild aus der Bibliothek');
  }
}

export function createCard(db: DB, input: { type: CardType; front: string; back?: string; subjectId?: number | null; sourceId?: number | null }): CardDTO {
  const card = { type: input.type, front: input.front.trim().slice(0, LIMITS_TEXT.cardFront), back: (input.back ?? '').trim().slice(0, LIMITS_TEXT.cardBack), sourceId: input.sourceId ?? null };
  validateCard(db, card);
  const src = card.sourceId === null ? null : (db.prepare('SELECT name, subject_id AS subjectId FROM sources WHERE id = ?').get(card.sourceId) as { name: string; subjectId: number | null } | undefined);
  if (card.sourceId !== null && !src) throw new HttpError(400, 'invalid_source', 'Quelle existiert nicht');
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        `INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, source_name, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, (SELECT id FROM subjects WHERE id = ?), ?, ?, ?, ?)`,
      )
      .run(card.type, card.front, card.back, input.subjectId ?? src?.subjectId ?? null, card.sourceId, src?.name ?? null, now, now).lastInsertRowid,
  );
  return getCard(db, id);
}

/** Bearbeiten ändert nur Inhalt/Status – Wiederholungsverlauf und Zeitplan bleiben erhalten. */
export function updateCard(db: DB, id: number, patch: { type?: CardType; front?: string; back?: string; status?: CardStatus; subjectId?: number | null }): CardDTO {
  const cur = getCard(db, id);
  const next = {
    type: patch.type ?? cur.type,
    front: patch.front !== undefined ? patch.front.trim().slice(0, LIMITS_TEXT.cardFront) : cur.front,
    back: patch.back !== undefined ? patch.back.trim().slice(0, LIMITS_TEXT.cardBack) : cur.back,
    sourceId: cur.sourceId,
  };
  validateCard(db, next);
  db.prepare('UPDATE cards SET type = ?, front = ?, back = ?, status = ?, subject_id = CASE WHEN ? THEN (SELECT id FROM subjects WHERE id = ?) ELSE subject_id END, updated_at = ? WHERE id = ?').run(
    next.type,
    next.front,
    next.back,
    patch.status ?? cur.status,
    patch.subjectId !== undefined ? 1 : 0,
    patch.subjectId ?? null,
    Date.now(),
    id,
  );
  return getCard(db, id);
}

export function deleteCard(db: DB, id: number): void {
  if (!Number(db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes)) throw new HttpError(404, 'not_found', 'Karte nicht gefunden');
}

/** Entwürfe annehmen/verwerfen, Karten aussetzen/aktivieren – nichts landet ungeprüft im Stapel. */
export function bulkCards(db: DB, ids: number[], action: 'accept' | 'discard' | 'suspend' | 'activate'): number {
  const list = jsonList(ids.slice(0, LIMITS_TEXT.listMax));
  const now = Date.now();
  if (action === 'discard') return Number(db.prepare("DELETE FROM cards WHERE status = 'draft' AND id IN (SELECT value FROM json_each(?))").run(list).changes);
  if (action === 'accept') return Number(db.prepare("UPDATE cards SET status = 'active', updated_at = ? WHERE status = 'draft' AND id IN (SELECT value FROM json_each(?))").run(now, list).changes);
  if (action === 'suspend') return Number(db.prepare("UPDATE cards SET status = 'suspended', updated_at = ? WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))").run(now, list).changes);
  return Number(db.prepare("UPDATE cards SET status = 'active', updated_at = ? WHERE status = 'suspended' AND id IN (SELECT value FROM json_each(?))").run(now, list).changes);
}

export function endOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** Tägliche Fällig-Liste: fällige zuerst (älteste zuerst), neue (nie gelernte) danach. */
export function dueCards(db: DB, f: { subjectId?: number; sourceId?: number; limit?: number }, now = Date.now()): { items: CardDTO[]; due: number; fresh: number } {
  const where = ["c.status = 'active'", '(c.due IS NULL OR c.due <= ?)'];
  const params: number[] = [endOfToday(now)];
  if (f.subjectId) {
    where.push('c.subject_id = ?');
    params.push(f.subjectId);
  }
  if (f.sourceId) {
    where.push('c.source_id = ?');
    params.push(f.sourceId);
  }
  const sql = where.join(' AND ');
  const items = (db.prepare(`${CARD_SELECT} WHERE ${sql} ORDER BY c.due IS NULL, c.due, c.id LIMIT ?`).all(...params, Math.min(f.limit ?? 200, LIMITS_TEXT.listMax)) as unknown as CardRow[]).map(toCard);
  const counts = db.prepare(`SELECT sum(c.due IS NOT NULL) AS due, sum(c.due IS NULL) AS fresh FROM cards c WHERE ${sql}`).get(...params) as { due: number | null; fresh: number | null };
  return { items, due: counts.due ?? 0, fresh: counts.fresh ?? 0 };
}

export function reviewCard(db: DB, id: number, rating: Rating, now = Date.now()): CardDTO {
  return tx(db, () => {
    const c = getCard(db, id);
    if (c.status !== 'active') throw new HttpError(409, 'card_not_active', 'Nur aktive Karten werden wiederholt');
    const next = review({ reps: c.reps, ease: c.ease, intervalDays: c.intervalDays }, rating, now);
    db.prepare('INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (?, ?, ?, ?, ?)').run(id, rating, now, next.intervalDays, next.ease);
    db.prepare('UPDATE cards SET reps = ?, ease = ?, interval_days = ?, lapses = lapses + ?, due = ?, last_review = ? WHERE id = ?').run(
      next.reps,
      next.ease,
      next.intervalDays,
      next.lapse ? 1 : 0,
      next.due,
      now,
      id,
    );
    return getCard(db, id);
  });
}

/** Statistik: Heatmap (Wiederholungen/Tag), Fälligkeitsprognose (30 Tage), Trefferquote (≠ „Nochmal“). */
export function srsStats(db: DB, subjectId?: number, now = Date.now()) {
  const sub = subjectId ? 'AND c.subject_id = ?' : '';
  const sp = subjectId ? [subjectId] : [];
  const since = now - 182 * DAY;
  const heatmap = db
    .prepare(
      `SELECT date(r.reviewed_at / 1000, 'unixepoch', 'localtime') AS day, count(*) AS n, sum(r.rating > 1) AS ok
       FROM reviews r ${subjectId ? 'JOIN cards c ON c.id = r.card_id' : ''} WHERE r.reviewed_at >= ? ${sub} GROUP BY day ORDER BY day`,
    )
    .all(since, ...sp) as { day: string; n: number; ok: number }[];
  const forecast = db
    .prepare(
      `SELECT max(date(c.due / 1000, 'unixepoch', 'localtime'), date(?, 'unixepoch', 'localtime')) AS day, count(*) AS n
       FROM cards c WHERE c.status = 'active' AND c.due IS NOT NULL AND c.due < ? ${sub} GROUP BY day ORDER BY day`,
    )
    .all(Math.floor(now / 1000), now + 30 * DAY, ...sp) as { day: string; n: number }[];
  const ret = db
    .prepare(`SELECT count(*) AS total, coalesce(sum(r.rating > 1), 0) AS ok FROM reviews r ${subjectId ? 'JOIN cards c ON c.id = r.card_id' : ''} WHERE r.reviewed_at >= ? ${sub}`)
    .get(now - 30 * DAY, ...sp) as { total: number; ok: number };
  const counts = db
    .prepare(
      `SELECT coalesce(sum(c.status = 'active'), 0) AS active, coalesce(sum(c.status = 'draft'), 0) AS draft, coalesce(sum(c.status = 'suspended'), 0) AS suspended,
              coalesce(sum(c.status = 'active' AND c.due IS NULL), 0) AS fresh, coalesce(sum(c.status = 'active' AND c.due <= ?), 0) AS due
       FROM cards c WHERE 1 = 1 ${sub}`,
    )
    .get(endOfToday(now), ...sp) as Record<string, number>;
  return { heatmap, forecast, retention: { total: ret.total, ok: ret.ok, rate: ret.total ? ret.ok / ret.total : null }, counts };
}

/* ============================================================ Quiz */

export interface QuestionRow {
  id: number;
  type: 'mc' | 'tf' | 'cloze' | 'short';
  question: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  topic: string | null;
  subject_id: number | null;
  source_id: number | null;
  chunk_id: number | null;
  source_name: string | null;
  loc: string | null;
  live_name?: string | null;
}

export interface QuizScope {
  subjectId?: number;
  sourceIds?: number[];
}

function quizWhere(scope: QuizScope): { sql: string; params: (string | number)[] } {
  if (scope.sourceIds?.length) return { sql: 'WHERE q.source_id IN (SELECT value FROM json_each(?))', params: [jsonList(scope.sourceIds)] };
  if (scope.subjectId) return { sql: 'WHERE q.subject_id = ?', params: [scope.subjectId] };
  return { sql: '', params: [] };
}

/** Antwortoptionen mischen (kleine Modelle setzen die richtige Lösung gern an Position 1). */
function shuffle<T>(a: T[] | null): T[] | null {
  if (!a) return a;
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function poolSize(db: DB, scope: QuizScope): number {
  const { sql, params } = quizWhere(scope);
  return (db.prepare(`SELECT count(*) AS n FROM quiz_questions q ${sql}`).get(...params) as { n: number }).n;
}

/** Fragen für eine Runde: zuerst nie beantwortete, dann die mit der schlechtesten Quote (Fragenpool wird wiederverwendet). */
export function startSession(db: DB, input: { mode: 'practice' | 'exam'; scope: QuizScope; count: number; timeLimitSec?: number | null }) {
  const { sql, params } = quizWhere(input.scope);
  const rows = db
    .prepare(
      `SELECT q.id, q.type, q.question, q.options, q.topic, q.source_id, coalesce(s.name, q.source_name) AS live_name
       FROM quiz_questions q LEFT JOIN sources s ON s.id = q.source_id
       LEFT JOIN (SELECT question_id, count(*) AS n, avg(score) AS avg FROM quiz_attempts GROUP BY question_id) st ON st.question_id = q.id
       ${sql} ORDER BY st.n IS NOT NULL, st.avg, random() LIMIT ?`,
    )
    .all(...params, Math.min(100, Math.max(1, input.count))) as unknown as QuestionRow[];
  if (!rows.length) throw new HttpError(409, 'quiz_pool_empty', 'Noch keine Fragen – erst Fragen erzeugen');
  const id = Number(
    db
      .prepare('INSERT INTO quiz_sessions(mode, scope, question_ids, time_limit_sec, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.mode, JSON.stringify(input.scope), JSON.stringify(rows.map((r) => r.id)), input.mode === 'exam' ? (input.timeLimitSec ?? 600) : null, Date.now()).lastInsertRowid,
  );
  return {
    session: { id, mode: input.mode, timeLimitSec: input.mode === 'exam' ? (input.timeLimitSec ?? 600) : null, startedAt: Date.now() },
    // ohne Lösung – die kommt erst mit der Bewertung
    questions: rows.map((r) => ({ id: r.id, type: r.type, question: r.question, options: shuffle(parse<string[] | null>(r.options, null)), topic: r.topic, sourceName: r.live_name ?? null })),
  };
}

export function getQuestion(db: DB, id: number): QuestionRow {
  const q = db.prepare('SELECT q.*, s.name AS live_name FROM quiz_questions q LEFT JOIN sources s ON s.id = q.source_id WHERE q.id = ?').get(id) as QuestionRow | undefined;
  if (!q) throw new HttpError(404, 'not_found', 'Frage nicht gefunden');
  return q;
}

const normAnswer = (s: string) => contentTokens(s).join(' ') || s.trim().toLowerCase();

/** Geschlossene Fragen lokal bewerten (keine KI nötig). */
export function gradeClosed(q: QuestionRow, answer: string): number {
  if (q.type === 'mc') return answer.trim() === q.answer.trim() ? 1 : 0;
  if (q.type === 'tf') return answer.trim().toLowerCase() === q.answer ? 1 : 0;
  return normAnswer(answer) === normAnswer(q.answer) ? 1 : 0;
}

export interface GradeDeps {
  call: <T>(fn: (o: CallOpts) => Promise<T>) => Promise<T>;
  search: (q: string, sourceIds: number[] | null) => Promise<SearchHit[]>;
  lang: 'de' | 'en';
  numCtx: number;
}

/** Freitext gegen die Quellen bewerten: zitierter Abschnitt der Frage + passende Treffer, Rubrik, Begründung, wörtliche Zitate. */
export async function gradeShort(db: DB, q: QuestionRow, answer: string, deps: GradeDeps): Promise<Grade & { refs: Ref[] }> {
  const docs: LChunk[] = [];
  const add = (c: LChunk) => {
    if (c.id !== null && docs.some((d) => d.id === c.id)) return;
    docs.push(c);
  };
  if (q.chunk_id) {
    const c = db
      .prepare(
        `SELECT c.id, c.source_id AS sourceId, s.name AS sourceName, s.kind AS sourceKind, c.text, c.heading, c.loc_kind AS locKind, c.loc_start AS locStart,
                c.loc_end AS locEnd, c.loc_label AS locLabel, c.origin FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?`,
      )
      .get(q.chunk_id) as LChunk | undefined;
    if (c) add(c);
  }
  try {
    for (const h of await deps.search(q.question, q.source_id ? [q.source_id] : null)) add({ ...h, id: h.chunkId, sourceKind: h.sourceKind ?? null, origin: h.origin ?? null });
  } catch {
    /* Suche optional */
  }
  // Kontext begrenzen (num_ctx): Abschnitte bis ~50 % des Kontexts
  const budget = Math.floor(deps.numCtx * 0.5);
  const used: LChunk[] = [];
  let tokens = 0;
  for (const d of docs) {
    const t = estimateTokens(d.text) + 30;
    if (used.length && tokens + t > budget) break;
    used.push(d);
    tokens += t;
  }
  if (!used.length) throw new HttpError(409, 'quiz_no_source', 'Zur Frage gibt es keinen Quelltext mehr');
  const grade = await deps.call((o) => callValidated(o, gradeMessages(documentsBlock(used), q.question, q.answer, answer.slice(0, 4000), deps.lang), GRADE_SCHEMA, 700, (raw) => parseGrade(raw, used)));
  const refs = used.map((c, i) => ({ n: i + 1, chunkId: c.id, sourceId: c.sourceId, sourceName: c.sourceName, loc: c.locKind ? { k: c.locKind, s: c.locStart, e: c.locEnd, l: c.locLabel } : null, heading: c.heading }));
  return { ...grade, refs };
}

export function questionRef(q: QuestionRow, db: DB): Ref & { chat?: number } {
  const snap = parse<(Loc & { chat?: number; t?: string }) | null>(q.loc, null);
  const live = q.chunk_id
    ? (db.prepare('SELECT loc_kind AS k, loc_start AS s, loc_end AS e, loc_label AS l, heading FROM chunks WHERE id = ?').get(q.chunk_id) as (Loc & { heading: string | null }) | undefined)
    : undefined;
  return {
    n: 1,
    chunkId: q.chunk_id,
    sourceId: q.source_id,
    sourceName: q.live_name ?? q.source_name ?? (snap?.t ? String(snap.t) : ''),
    loc: live ? { k: live.k, s: live.s, e: live.e, l: live.l } : snap && snap.chat === undefined ? snap : null,
    heading: live?.heading ?? null,
    deleted: q.source_id === null && q.source_name !== null,
    ...(snap?.chat ? { chatId: snap.chat } : {}),
  };
}

export function recordAttempt(db: DB, questionId: number, sessionId: number | null, answer: string, score: number, feedback: unknown): void {
  db.prepare('INSERT INTO quiz_attempts(question_id, session_id, answer, score, feedback, created_at) VALUES (?, (SELECT id FROM quiz_sessions WHERE id = ?), ?, ?, ?, ?)').run(
    questionId,
    sessionId,
    answer.slice(0, 4000),
    score,
    feedback ? JSON.stringify(feedback) : null,
    Date.now(),
  );
}

export function finishSession(db: DB, id: number) {
  const s = db.prepare('SELECT * FROM quiz_sessions WHERE id = ?').get(id) as { id: number; question_ids: string; started_at: number; finished_at: number | null } | undefined;
  if (!s) throw new HttpError(404, 'not_found', 'Quiz nicht gefunden');
  if (!s.finished_at) db.prepare('UPDATE quiz_sessions SET finished_at = ? WHERE id = ?').run(Date.now(), id);
  const total = parse<number[]>(s.question_ids, []).length;
  const r = db.prepare('SELECT count(*) AS answered, coalesce(sum(score), 0) AS points FROM quiz_attempts WHERE session_id = ?').get(id) as { answered: number; points: number };
  return { id, total, answered: r.answered, points: Math.round(r.points * 100) / 100 };
}

export function quizHistory(db: DB) {
  return db
    .prepare(
      `SELECT s.id, s.mode, s.started_at AS startedAt, s.finished_at AS finishedAt, s.time_limit_sec AS timeLimitSec, json_array_length(s.question_ids) AS total,
              count(a.id) AS answered, coalesce(sum(a.score), 0) AS points
       FROM quiz_sessions s LEFT JOIN quiz_attempts a ON a.session_id = s.id GROUP BY s.id ORDER BY s.id DESC LIMIT 50`,
    )
    .all();
}

/** Schwächen-Analyse: Themen (Abschnitt/Quelle) mit niedriger Quote -> Wiederholungsvorschlag (Abschnitt + Karten dazu). */
export function weaknesses(db: DB, subjectId?: number) {
  const rows = db
    .prepare(
      `SELECT q.topic, q.source_id AS sourceId, coalesce(s.name, q.source_name) AS sourceName, min(q.chunk_id) AS chunkId,
              count(*) AS attempts, avg(a.score) AS avg
       FROM quiz_attempts a JOIN quiz_questions q ON q.id = a.question_id LEFT JOIN sources s ON s.id = q.source_id
       ${subjectId ? 'WHERE q.subject_id = ?' : ''}
       GROUP BY q.topic, q.source_id HAVING avg(a.score) < 0.7 ORDER BY avg(a.score), count(*) DESC LIMIT 10`,
    )
    .all(...(subjectId ? [subjectId] : [])) as { topic: string | null; sourceId: number | null; sourceName: string | null; chunkId: number | null; attempts: number; avg: number }[];
  const ids = rows.map((r) => r.sourceId).filter((x): x is number => x !== null);
  const cards = new Map(
    (db.prepare("SELECT source_id AS id, count(*) AS n FROM cards WHERE status = 'active' AND source_id IN (SELECT value FROM json_each(?)) GROUP BY source_id").all(jsonList(ids)) as {
      id: number;
      n: number;
    }[]).map((r) => [r.id, r.n]),
  );
  return rows.map((r) => ({ ...r, avg: Math.round(r.avg * 100) / 100, cards: r.sourceId ? (cards.get(r.sourceId) ?? 0) : 0 }));
}

/* ============================================================ Wissensgraph */

export const GRAPH_VIEW_MAX = 2000;

export function graphData(db: DB, f: { subjectId?: number; sourceId?: number; includeHidden?: boolean }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.sourceId) {
    where.push('cs.source_id = ?');
    params.push(f.sourceId);
  } else if (f.subjectId) {
    where.push('cs.source_id IN (SELECT id FROM sources WHERE subject_id = ?)');
    params.push(f.subjectId);
  }
  if (!f.includeHidden) where.push('c.hidden = 0');
  const nodes = db
    .prepare(
      `SELECT c.id, c.name, c.hidden, count(cs.source_id) AS sources FROM concepts c JOIN concept_sources cs ON cs.concept_id = c.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY c.id`,
    )
    .all(...params) as { id: number; name: string; hidden: number; sources: number }[];
  const ids = jsonList(nodes.map((n) => n.id));
  const edges = db
    .prepare(
      `SELECT min(e.id) AS id, e.a, e.b, min(e.label) AS label, max(e.hidden) AS hidden FROM concept_edges e
       WHERE e.a IN (SELECT value FROM json_each(?)) AND e.b IN (SELECT value FROM json_each(?)) GROUP BY e.a, e.b`,
    )
    .all(ids, ids) as { id: number; a: number; b: number; label: string; hidden: number }[];
  const shownEdges = f.includeHidden ? edges : edges.filter((e) => !e.hidden);
  const degree = new Map<number, number>();
  for (const e of shownEdges) {
    degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
    degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
  }
  // Ansicht bleibt flüssig: höchstens GRAPH_VIEW_MAX Knoten (die am stärksten vernetzten)
  const sorted = nodes.map((n) => ({ ...n, hidden: !!n.hidden, degree: degree.get(n.id) ?? 0 })).sort((x, y) => y.degree - x.degree || y.sources - x.sources || x.id - y.id);
  const kept = sorted.slice(0, GRAPH_VIEW_MAX);
  const keep = new Set(kept.map((n) => n.id));
  return {
    nodes: kept,
    edges: shownEdges.filter((e) => keep.has(e.a) && keep.has(e.b)).map((e) => ({ ...e, hidden: !!e.hidden })),
    total: nodes.length,
    truncated: nodes.length > kept.length,
  };
}

export function conceptDetail(db: DB, id: number) {
  const c = db.prepare('SELECT id, name, description, hidden, edited FROM concepts WHERE id = ?').get(id) as
    | { id: number; name: string; description: string | null; hidden: number; edited: number }
    | undefined;
  if (!c) throw new HttpError(404, 'not_found', 'Konzept nicht gefunden');
  const sources = db
    .prepare(
      `SELECT cs.source_id AS sourceId, s.name AS sourceName, s.subject_id AS subjectId, cs.chunk_id AS chunkId, ch.text, ch.loc_kind, ch.loc_start, ch.loc_end, ch.loc_label
       FROM concept_sources cs JOIN sources s ON s.id = cs.source_id LEFT JOIN chunks ch ON ch.id = cs.chunk_id WHERE cs.concept_id = ? ORDER BY s.name LIMIT 100`,
    )
    .all(id) as { sourceId: number; sourceName: string; subjectId: number | null; chunkId: number | null; text: string | null; loc_kind: string | null; loc_start: number | null; loc_end: number | null; loc_label: string | null }[];
  const neighbors = db
    .prepare(
      `SELECT e.id AS edgeId, e.label, e.hidden, CASE WHEN e.a = ? THEN e.b ELSE e.a END AS id, k.name
       FROM concept_edges e JOIN concepts k ON k.id = CASE WHEN e.a = ? THEN e.b ELSE e.a END WHERE e.a = ? OR e.b = ? ORDER BY k.name LIMIT 200`,
    )
    .all(id, id, id, id) as { edgeId: number; label: string; hidden: number; id: number; name: string }[];
  return {
    ...c,
    hidden: !!c.hidden,
    edited: !!c.edited,
    sources: sources.map((s) => ({
      sourceId: s.sourceId,
      sourceName: s.sourceName,
      subjectId: s.subjectId,
      chunkId: s.chunkId,
      snippet: s.text ? s.text.slice(0, 300) : null,
      loc: s.loc_kind ? { k: s.loc_kind, s: s.loc_start, e: s.loc_end, l: s.loc_label } : null,
    })),
    neighbors: neighbors.map((n) => ({ ...n, hidden: !!n.hidden })),
  };
}

/** Korrigieren: Name/Beschreibung ändern (normalisierter Name bleibt -> spätere Extraktion trifft dasselbe Konzept), ausblenden. */
export function updateConcept(db: DB, id: number, patch: { name?: string; description?: string; hidden?: boolean }) {
  conceptDetail(db, id);
  if (patch.name !== undefined) {
    const n = cleanText(patch.name, 80);
    if (!n) throw new HttpError(400, 'invalid_name', 'Name fehlt');
    db.prepare('UPDATE concepts SET name = ?, edited = 1 WHERE id = ?').run(n, id);
  }
  if (patch.description !== undefined) db.prepare('UPDATE concepts SET description = ?, edited = 1 WHERE id = ?').run(cleanText(patch.description, 400) || null, id);
  if (patch.hidden !== undefined) db.prepare('UPDATE concepts SET hidden = ? WHERE id = ?').run(patch.hidden ? 1 : 0, id);
  return conceptDetail(db, id);
}

/** Kante korrigieren/ausblenden – gilt für die Verbindung (beide Konzepte), auch wenn mehrere Quellen sie liefern. */
export function updateEdge(db: DB, id: number, patch: { label?: string; hidden?: boolean }): void {
  const e = db.prepare('SELECT a, b FROM concept_edges WHERE id = ?').get(id) as { a: number; b: number } | undefined;
  if (!e) throw new HttpError(404, 'not_found', 'Verbindung nicht gefunden');
  if (patch.label !== undefined) {
    const l = cleanText(patch.label, 60);
    if (!l) throw new HttpError(400, 'invalid_name', 'Bezeichnung fehlt');
    db.prepare('UPDATE concept_edges SET label = ? WHERE a = ? AND b = ?').run(l, e.a, e.b);
  }
  if (patch.hidden !== undefined) db.prepare('UPDATE concept_edges SET hidden = ? WHERE a = ? AND b = ?').run(patch.hidden ? 1 : 0, e.a, e.b);
}

