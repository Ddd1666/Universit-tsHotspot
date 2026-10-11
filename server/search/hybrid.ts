import { jsonList, type DB } from '../db.ts';
import type { VectorStore } from '../embed/vector-store.ts';
import { embedPrefix } from '../embed/embed-queue.ts';
import type { OllamaClient } from '../ollama/client.ts';

export type Scope =
  | { mode: 'all' }
  | { mode: 'subjects'; ids: number[] }
  | { mode: 'sources'; ids: number[] }
  | { mode: 'none' };

export function parseScope(raw: unknown): Scope {
  const r = (typeof raw === 'string' ? safeJson(raw) : raw) as { mode?: string; ids?: unknown } | null;
  const ids = Array.isArray(r?.ids) ? (r!.ids as unknown[]).filter((x): x is number => Number.isInteger(x)).slice(0, 5000) : [];
  switch (r?.mode) {
    case 'subjects':
      return { mode: 'subjects', ids };
    case 'sources':
      return { mode: 'sources', ids };
    case 'none':
      return { mode: 'none' };
    default:
      return { mode: 'all' };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface SearchHit {
  chunkId: number;
  sourceId: number;
  sourceName: string;
  subjectId: number | null;
  subjectName: string | null;
  subjectColor: string | null;
  text: string;
  heading: string | null;
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  /** Ausschnitt; Treffer markiert mit \u0002 … \u0003 (UI rendert <mark> ohne innerHTML) */
  snippet: string;
  score: number;
  matchedBy: ('fts' | 'vector')[];
}

export interface SearchResult {
  hits: SearchHit[];
  mode: 'hybrid' | 'fts' | 'vector' | 'empty';
  tookMs: number;
  vectorError: string | null;
}

export const RRF_K = 60;
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

/** Reciprocal Rank Fusion: score = Σ 1 / (k + rank). Rang beginnt bei 1. */
export function rrfFuse(lists: number[][], k = RRF_K): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id - b.id);
}

/**
 * Nutzereingabe -> sichere FTS5-Query: nur Wort-Tokens, jeweils in Anführungszeichen (keine FTS-Syntax-Injection),
 * ODER-verknüpft; längere Wörter zusätzlich als Präfix des Wortstamms (einfaches DE-Stemming: "Vektoren" ~ "Vektor*").
 */
export function buildFtsQuery(input: string): string | null {
  const tokens = (input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2).slice(0, 24);
  if (!tokens.length) return null;
  const parts = new Set<string>();
  for (const t of tokens) {
    parts.add(`"${t}"`);
    if (t.length >= 6) parts.add(`"${t.slice(0, Math.max(5, t.length - 3))}"*`);
  }
  return [...parts].join(' OR ');
}

/** Erlaubte Quellen für einen Wissensbereich; null = alle. */
export function allowedSourceIds(db: DB, scope: Scope): Set<number> | null {
  if (scope.mode === 'all') return null;
  if (scope.mode === 'none') return new Set();
  if (scope.mode === 'subjects') {
    const rows = db.prepare('SELECT id FROM sources WHERE subject_id IN (SELECT value FROM json_each(?))').all(jsonList(scope.ids)) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }
  // einzelne Quellen inkl. Inhalte ausgewählter Archive
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (SELECT value FROM json_each(?) UNION SELECT s.id FROM sources s JOIN tree t ON s.parent_id = t.id)
       SELECT id FROM tree`,
    )
    .all(jsonList(scope.ids)) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function makeSnippet(text: string, query: string, len = 260): string {
  const tokens = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((t) => t.slice(0, 6));
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    pos = lower.indexOf(t);
    if (pos !== -1) break;
  }
  const start = pos > 80 ? text.lastIndexOf(' ', pos - 60) + 1 : 0;
  let s = text.slice(start, start + len).replace(/\s+/g, ' ');
  if (start > 0) s = '…' + s;
  if (start + len < text.length) s += '…';
  return s;
}

export interface HybridDeps {
  db: DB;
  vectors: VectorStore;
  client: OllamaClient | null;
}

export async function hybridSearch(
  deps: HybridDeps,
  query: string,
  opts: { scope?: Scope; limit?: number; candidates?: number; signal?: AbortSignal } = {},
): Promise<SearchResult> {
  const t0 = performance.now();
  const { db, vectors, client } = deps;
  const limit = opts.limit ?? 10;
  const cand = opts.candidates ?? 40;
  const scope = opts.scope ?? { mode: 'all' };
  const allowed = allowedSourceIds(db, scope);
  if ((allowed && allowed.size === 0) || !query.trim()) return { hits: [], mode: 'empty', tookMs: 0, vectorError: null };

  // --- Volltext (BM25)
  const ftsIds: number[] = [];
  const snippets = new Map<number, string>();
  const fts = buildFtsQuery(query);
  if (fts) {
    const rows = db
      .prepare(
        `SELECT c.id, snippet(chunks_fts, 0, '${MARK_START}', '${MARK_END}', '…', 28) AS snip
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? ${allowed ? 'AND c.source_id IN (SELECT value FROM json_each(?))' : ''}
         ORDER BY bm25(chunks_fts, 1.0, 0.4) LIMIT ?`,
      )
      .all(...(allowed ? [fts, jsonList([...allowed]), cand] : [fts, cand])) as { id: number; snip: string }[];
    for (const r of rows) {
      ftsIds.push(r.id);
      snippets.set(r.id, r.snip);
    }
  }

  // --- Vektor (Cosine) – nur wenn Index vorhanden und Ollama erreichbar
  let vecIds: number[] = [];
  let vectorError: string | null = null;
  const info = vectors.info();
  if (client && info.model && info.count > 0) {
    try {
      const [qv] = await client.embed(info.model, [embedPrefix(info.model, 'query') + query], { retries: 0, timeoutMs: 15_000, signal: opts.signal });
      vecIds = vectors.search(qv!, cand, allowed).map((h) => h.chunkId);
    } catch (err) {
      vectorError = (err as Error).message;
    }
  }

  const fused = rrfFuse([ftsIds, vecIds]).slice(0, limit);
  if (!fused.length) {
    return { hits: [], mode: info.count && !vectorError ? 'hybrid' : 'fts', tookMs: Math.round(performance.now() - t0), vectorError };
  }
  const ftsSet = new Set(ftsIds);
  const vecSet = new Set(vecIds);
  const rows = db
    .prepare(
      `SELECT c.id AS chunkId, c.source_id AS sourceId, s.name AS sourceName, s.subject_id AS subjectId, sub.name AS subjectName,
              sub.color AS subjectColor, c.text, c.heading, c.loc_kind AS locKind, c.loc_start AS locStart, c.loc_end AS locEnd, c.loc_label AS locLabel
       FROM chunks c JOIN sources s ON s.id = c.source_id LEFT JOIN subjects sub ON sub.id = s.subject_id
       WHERE c.id IN (SELECT value FROM json_each(?))`,
    )
    .all(jsonList(fused.map((f) => f.id))) as unknown as Omit<SearchHit, 'snippet' | 'score' | 'matchedBy'>[];
  const byId = new Map(rows.map((r) => [r.chunkId, r]));
  const hits: SearchHit[] = [];
  for (const f of fused) {
    const r = byId.get(f.id);
    if (!r) continue; // verwaiste Vektoren werden ignoriert
    const matchedBy: SearchHit['matchedBy'] = [];
    if (ftsSet.has(f.id)) matchedBy.push('fts');
    if (vecSet.has(f.id)) matchedBy.push('vector');
    hits.push({ ...r, snippet: snippets.get(f.id) ?? makeSnippet(r.text, query), score: f.score, matchedBy });
  }
  const mode = ftsIds.length && vecIds.length ? 'hybrid' : vecIds.length ? 'vector' : 'fts';
  return { hits, mode, tookMs: Math.round(performance.now() - t0), vectorError };
}
