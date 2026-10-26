import crypto from 'node:crypto';
import { jsonList, type DB } from '../db.ts';
import { CHARS_PER_TOKEN, estimateTokens, locationLabel } from '../ingest/chunker.ts';
import { escapeDocText } from '../chat/prompt.ts';
import { allowedSourceIds, germanStem } from '../search/hybrid.ts';
import { HttpError } from '../library.ts';

/** Woraus generiert wird: Quelle (optional ein Abschnitt = Überschrift), Auswahl mehrerer Quellen, Fach oder Chat-Verlauf. */
export type LearnScope =
  | { kind: 'source'; id: number; heading?: string | null }
  | { kind: 'sources'; ids: number[] }
  | { kind: 'subject'; id: number }
  | { kind: 'chat'; id: number };

export interface LChunk {
  id: number | null;
  sourceId: number | null;
  sourceName: string;
  sourceKind: string | null;
  text: string;
  heading: string | null;
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  origin: string | null;
  /** nur Chat-Verlauf */
  chatId?: number;
}

/** Quellenverweis einer Notiz/Karte/Frage – genug Information, um ihn auch nach Löschen der Quelle anzuzeigen. */
export interface Ref {
  n: number;
  chunkId: number | null;
  sourceId: number | null;
  sourceName: string;
  loc: Loc | null;
  heading: string | null;
  chatId?: number;
  /** nur in API-Antworten: Quelle existiert nicht mehr */
  deleted?: boolean;
}

/** Position kompakt (Client formatiert lokalisiert). */
export interface Loc {
  k: string | null;
  s: number | null;
  e: number | null;
  l: string | null;
}

export const MAX_SCOPE_IDS = 500;

export function parseLearnScope(raw: unknown): LearnScope {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = Number(r.id);
  if (r.kind === 'source' && Number.isInteger(id) && id > 0) {
    const heading = typeof r.heading === 'string' && r.heading.trim() ? r.heading.slice(0, 300) : null;
    return { kind: 'source', id, heading };
  }
  if (r.kind === 'subject' && Number.isInteger(id) && id > 0) return { kind: 'subject', id };
  if (r.kind === 'chat' && Number.isInteger(id) && id > 0) return { kind: 'chat', id };
  if (r.kind === 'sources' && Array.isArray(r.ids)) {
    const ids = [...new Set(r.ids.filter((x): x is number => Number.isInteger(x) && x > 0))].slice(0, MAX_SCOPE_IDS);
    if (ids.length) return { kind: 'sources', ids };
  }
  throw new HttpError(400, 'learn_invalid_scope', 'Ungültiger Bereich');
}

export function locOf(c: Pick<LChunk, 'locKind' | 'locStart' | 'locEnd' | 'locLabel'>): Loc | null {
  return c.locKind ? { k: c.locKind, s: c.locStart, e: c.locEnd, l: c.locLabel } : null;
}

const CHUNK_COLS = `c.id, c.source_id AS sourceId, s.name AS sourceName, s.kind AS sourceKind, c.text, c.heading, c.loc_kind AS locKind,
  c.loc_start AS locStart, c.loc_end AS locEnd, c.loc_label AS locLabel, c.origin`;

/**
 * Abschnitte eines Bereichs in Lesereihenfolge (je Quelle nach ord), höchstens `max`. Fach/Auswahl schließen Archiv-Inhalte ein.
 * Chat: jede Nachricht wird ein Pseudo-Abschnitt (ohne Quelle).
 */
export function loadScope(db: DB, scope: LearnScope, max: number): { chunks: LChunk[]; truncated: boolean; total: number; title: string; subjectId: number | null } {
  if (scope.kind === 'chat') {
    const chat = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(scope.id) as { title: string } | undefined;
    if (!chat) throw new HttpError(404, 'not_found', 'Chat nicht gefunden');
    const all = db
      .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? AND content != '' AND status IN ('done', 'aborted') ORDER BY id LIMIT 5000")
      .all(scope.id) as { role: string; content: string }[];
    const rows = evenPick(all.length, max).map((i) => all[i]!);
    const name = `Chat: ${chat.title || '…'}`;
    const chunks = rows.map((r, i) => ({
      id: null,
      sourceId: null,
      sourceName: name,
      sourceKind: null,
      text: `${r.role === 'user' ? 'Question' : 'Answer'}: ${r.role === 'assistant' ? r.content.replace(/\[\d{1,3}\]/g, '') : r.content}`.slice(0, 12_000),
      heading: null,
      locKind: 'message',
      locStart: i + 1,
      locEnd: i + 1,
      locLabel: null,
      origin: null,
      chatId: scope.id,
    }));
    return { chunks, truncated: all.length > max, total: all.length, title: chat.title || name, subjectId: null };
  }
  let ids: number[];
  let title: string;
  let subjectId: number | null;
  if (scope.kind === 'subject') {
    const sub = db.prepare('SELECT name FROM subjects WHERE id = ?').get(scope.id) as { name: string } | undefined;
    if (!sub) throw new HttpError(404, 'not_found', 'Fach nicht gefunden');
    ids = [...(allowedSourceIds(db, { mode: 'subjects', ids: [scope.id] }) ?? [])];
    title = sub.name;
    subjectId = scope.id;
  } else {
    const list = scope.kind === 'source' ? [scope.id] : scope.ids;
    ids = [...(allowedSourceIds(db, { mode: 'sources', ids: list }) ?? [])];
    // Titel/Fach aus der ersten noch vorhandenen Quelle der Auswahl
    const existing = new Map(
      (db.prepare('SELECT id, name, subject_id AS subjectId FROM sources WHERE id IN (SELECT value FROM json_each(?))').all(jsonList(list)) as {
        id: number;
        name: string;
        subjectId: number | null;
      }[]).map((r) => [r.id, r]),
    );
    const first = list.map((id) => existing.get(id)).find(Boolean);
    if (!first) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
    title = scope.kind === 'source' ? (scope.heading ? `${first.name} – ${scope.heading}` : first.name) : existing.size > 1 ? `${first.name} +${existing.size - 1}` : first.name;
    subjectId = first.subjectId;
  }
  const heading = scope.kind === 'source' ? scope.heading : null;
  // Erst nur IDs (Index), dann gerecht je Quelle und gleichmäßig über jedes Dokument auswählen – nicht nur älteste Quellen/Anfänge
  const all = db
    .prepare(`SELECT c.id, c.source_id AS sourceId FROM chunks c WHERE c.source_id IN (SELECT value FROM json_each(?)) ${heading ? 'AND c.heading = ?' : ''} ORDER BY c.source_id, c.ord`)
    .all(...(heading ? [jsonList(ids), heading] : [jsonList(ids)])) as { id: number; sourceId: number }[];
  const chosen = all.length > max ? sampleChunks(all, max) : all.map((r) => r.id);
  const rows = db
    .prepare(`SELECT ${CHUNK_COLS} FROM chunks c JOIN sources s ON s.id = c.source_id WHERE c.id IN (SELECT value FROM json_each(?)) ORDER BY c.source_id, c.ord`)
    .all(jsonList(chosen)) as unknown as LChunk[];
  return { chunks: rows, truncated: all.length > max, total: all.length, title, subjectId };
}

/** k von n Indizes gleichmäßig verteilt (Anfang, Mitte, Ende). */
export function evenPick(n: number, k: number): number[] {
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: Math.max(0, k) }, (_, j) => Math.floor((j * n) / k));
}

/**
 * Auswahl bei zu vielen Abschnitten: gerechtes Kontingent je Quelle (kleine Quellen geben ihren Rest an große ab),
 * innerhalb jeder Quelle gleichmäßig über das Dokument verteilt. `rows` in Lesereihenfolge je Quelle.
 */
export function sampleChunks(rows: { id: number; sourceId: number | null }[], max: number): number[] {
  const bySource = new Map<number | null, number[]>();
  for (const r of rows) {
    const l = bySource.get(r.sourceId);
    if (l) l.push(r.id);
    else bySource.set(r.sourceId, [r.id]);
  }
  const lists = [...bySource.values()].sort((a, b) => a.length - b.length);
  const quota = lists.map(() => 0);
  let remaining = max;
  lists.forEach((l, i) => {
    quota[i] = Math.min(l.length, Math.floor(remaining / (lists.length - i)));
    remaining -= quota[i]!;
  });
  for (let i = 0; i < lists.length && remaining > 0; i++) {
    if (quota[i]! < lists[i]!.length) {
      quota[i]!++;
      remaining--;
    }
  }
  return lists.flatMap((l, i) => evenPick(l.length, quota[i]!).map((j) => l[j]!));
}

/** Abschnitte in Gruppen bis `maxTokens` (nie über Quellgrenzen, damit Zwischenergebnisse einer Quelle zugeordnet bleiben). */
export function groupChunks(chunks: LChunk[], maxTokens: number): LChunk[][] {
  const groups: LChunk[][] = [];
  let cur: LChunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const cost = estimateTokens(c.text) + 30;
    if (cur.length && (used + cost > maxTokens || cur[0]!.sourceId !== c.sourceId)) {
      groups.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(cost > maxTokens ? { ...c, text: c.text.slice(0, Math.floor((maxTokens - 30) * CHARS_PER_TOKEN)) } : c);
    used += Math.min(cost, maxTokens);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function attr(s: string | null | undefined): string {
  return (s ?? '').replace(/["<>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Dokumentblock wie im Chat: Fremdtext als Daten abgegrenzt, eingeschleuste Tags neutralisiert. Nummern ab `start`. */
export function documentsBlock(group: LChunk[], start = 1): string {
  const parts = group.map((c, i) => {
    const loc = c.locKind === 'message' ? `message ${c.locStart}` : locationLabel(c);
    const gen = c.origin ? ` generated="${c.origin}"` : '';
    return `<document index="${start + i}" source="${attr(c.sourceName)}"${loc ? ` location="${attr(loc)}"` : ''}${c.heading ? ` section="${attr(c.heading)}"` : ''}${gen}>\n${escapeDocText(c.text)}\n</document>`;
  });
  return `<documents>\n${parts.join('\n')}\n</documents>`;
}

export function refOf(c: LChunk, n: number): Ref {
  return { n, chunkId: c.id, sourceId: c.sourceId, sourceName: c.sourceName, loc: c.locKind === 'message' ? null : locOf(c), heading: c.heading, ...(c.chatId ? { chatId: c.chatId } : {}) };
}

export function cacheKey(...parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Gruppen-Fingerabdruck: ändert sich der Text einer Quelle, ändert sich der Schlüssel (Cache-Invalidierung ohne Buchführung). */
export function groupKey(task: string, group: LChunk[], extra: unknown = null): string {
  return cacheKey(task, extra, group.map((c) => c.text));
}

/* ------------------------------------------------------------ Normalisierung / Plausibilität */

// Verneinungen (nicht/kein/not/no) sind bewusst KEINE Stoppwörter: "nimmt ab" ≠ "nimmt nicht ab"
const STOP = new Set(
  'der die das den dem des ein eine einer eines einem einen und oder aber ist sind war wird werden mit von zu im in am an auf aus bei für fur als auch wie was wer the a an and or of to in on for is are was be with by as at from that this it its'.split(' '),
);

/** Text vergleichbar machen: Kleinschrift, ohne Diakritika, Dezimalkomma -> Punkt, Satzzeichen -> Leerzeichen. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\.(\d)/g, '$1$2') // Dezimalpunkt kurz schützen (Zeichen aus dem Privatbereich)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(//g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inhaltswörter (≥ 3 Zeichen, ohne Stoppwörter), gestemmt, ohne Diakritika. */
export function contentTokens(s: string): string[] {
  return (s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP.has(t)).map(germanStem);
}

/** Plural-/Flexionsendung (DE/EN) einmal abschneiden, Doppelkonsonant am Ende vereinfachen: Prozess/Prozesse/processes -> proces. */
function nameStem(w: string): string {
  if (w.length < 5) return w;
  const suf = ['en', 'er', 'es', 'e', 'n', 's'].find((s) => w.endsWith(s) && w.length - s.length >= 4);
  const base = suf ? w.slice(0, -suf.length) : w;
  return /(\p{L})\1$/u.test(base) ? base.slice(0, -1) : base;
}

/** Konzeptnamen vergleichbar machen: Kleinschrift, ohne Diakritika/Satzzeichen/Klammerzusatz/Artikel, Wortstamm je Wort. */
export function normalizeName(name: string): string {
  const words =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/\([^()]{0,200}\)/g, ' ')
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  while (words.length > 1 && /^(der|die|das|den|dem|des|ein|eine|the|a|an)$/.test(words[0]!)) words.shift();
  return words.map(nameStem).join(' ').slice(0, 120);
}

/**
 * Plausibilität gegen die Quelle: Anteil der Inhaltswörter von `claim`, die im Quelltext vorkommen.
 * Kleine Modelle erfinden gern – Karten/Fragen/Konzepte unter der Schwelle werden verworfen.
 */
export function support(claim: string, sourceText: string): number {
  // kurze/numerische Antworten ("pH", "9,81 m/s²") haben kaum Inhaltswörter -> wörtlich im Quelltext enthalten zählt voll
  const n = normalizeText(claim);
  if (n && ` ${normalizeText(sourceText)} `.includes(` ${n} `)) return 1;
  const c = [...new Set(contentTokens(claim))];
  if (!c.length) return 0;
  const src = new Set(contentTokens(sourceText));
  return c.filter((t) => src.has(t)).length / c.length;
}

/** Wörtliches Zitat? (Leerraum/Groß-Klein/Anführungszeichen tolerant) */
export function isQuoteOf(quote: string, sourceText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[„“”"'‚‘’«»]/g, '').replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  return q.length >= 8 && norm(sourceText).includes(q);
}

/** Exakte Duplikate (normalisierter Text inkl. Zahlen und Verneinung); ähnliche erkennt die Embedding-Prüfung. */
export function fingerprint(s: string): string {
  return cacheKey(normalizeText(s));
}

/** Steuerzeichen raus, Länge begrenzen. */
export function cleanText(s: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof s === 'string' ? s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}
