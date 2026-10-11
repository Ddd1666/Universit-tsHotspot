import { jsonList, tx, type DB } from './db.ts';
import type { EventBus } from './events.ts';
import type { BlobStore } from './storage.ts';
import type { VectorStore } from './embed/vector-store.ts';

export interface Subject {
  id: number;
  name: string;
  color: string;
  createdAt: number;
  sourceCount: number;
}

export interface SourceDTO {
  id: number;
  subjectId: number | null;
  parentId: number | null;
  name: string;
  relPath: string | null;
  size: number;
  mime: string;
  kind: string;
  status: string;
  statusDetail: string | null;
  pageCount: number | null;
  chunkCount: number;
  embeddedCount: number;
  childCount: number;
  batchId: string | null;
  sha256: string;
  importedAt: number;
  processedAt: number | null;
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const SOURCE_COLUMNS = `
  s.id, s.subject_id AS subjectId, s.parent_id AS parentId, s.name, s.rel_path AS relPath, s.size, s.mime, s.kind,
  s.status, s.status_detail AS statusDetail, s.page_count AS pageCount, s.chunk_count AS chunkCount,
  (SELECT count(*) FROM chunks c WHERE c.source_id = s.id AND c.embed_state = 1) AS embeddedCount,
  (SELECT count(*) FROM sources k WHERE k.parent_id = s.id) AS childCount,
  s.batch_id AS batchId, s.sha256, s.imported_at AS importedAt, s.processed_at AS processedAt`;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return clean && !/^\.+$/.test(clean) ? clean : 'unbenannt';
}

/** Relativer Anzeige-Pfad (Ordner-/ZIP-Import). Wird nie für Dateisystemzugriffe verwendet. */
export function sanitizeRelPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    // eslint-disable-next-line no-control-regex
    .map((seg) => seg.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..' && !/^[a-zA-Z]:$/.test(seg));
  return parts.length ? parts.join('/').slice(0, 1024) : null;
}

export class Library {
  private readonly db: DB;
  private readonly blobs: BlobStore;
  private readonly vectors: VectorStore;
  private readonly bus: EventBus;
  /** Hook: laufende Verarbeitung abbrechen, bevor gelöscht wird (setzt der IngestService). */
  beforeDelete: (sourceIds: number[]) => void = () => {};

  constructor(db: DB, blobs: BlobStore, vectors: VectorStore, bus: EventBus) {
    this.db = db;
    this.blobs = blobs;
    this.vectors = vectors;
    this.bus = bus;
  }

  /* ------------------------------------------------------------ Fächer */

  listSubjects(): Subject[] {
    return this.db
      .prepare(
        `SELECT sub.id, sub.name, sub.color, sub.created_at AS createdAt,
          (SELECT count(*) FROM sources s WHERE s.subject_id = sub.id) AS sourceCount
         FROM subjects sub ORDER BY sub.name COLLATE NOCASE`,
      )
      .all() as unknown as Subject[];
  }

  subjectExists(id: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(id);
  }

  createSubject(name: string, color: string): Subject {
    const n = name.trim().slice(0, 80);
    if (!n) throw new HttpError(400, 'invalid_name', 'Name fehlt');
    if (!COLOR_RE.test(color)) throw new HttpError(400, 'invalid_color', 'Farbe muss #rrggbb sein');
    const r = this.db.prepare('INSERT INTO subjects(name, color, created_at) VALUES (?, ?, ?)').run(n, color, Date.now());
    this.bus.emit({ type: 'subjects' });
    return this.listSubjects().find((s) => s.id === Number(r.lastInsertRowid))!;
  }

  updateSubject(id: number, patch: { name?: string; color?: string }): Subject {
    if (!this.subjectExists(id)) throw new HttpError(404, 'not_found', 'Fach nicht gefunden');
    if (patch.name !== undefined) {
      const n = patch.name.trim().slice(0, 80);
      if (!n) throw new HttpError(400, 'invalid_name', 'Name fehlt');
      this.db.prepare('UPDATE subjects SET name = ? WHERE id = ?').run(n, id);
    }
    if (patch.color !== undefined) {
      if (!COLOR_RE.test(patch.color)) throw new HttpError(400, 'invalid_color', 'Farbe muss #rrggbb sein');
      this.db.prepare('UPDATE subjects SET color = ? WHERE id = ?').run(patch.color, id);
    }
    this.bus.emit({ type: 'subjects' });
    return this.listSubjects().find((s) => s.id === id)!;
  }

  /** Fach löschen: Quellen werden entweder mitgelöscht oder nach "Ohne Fach" verschoben. */
  async deleteSubject(id: number, deleteSources: boolean): Promise<void> {
    if (!this.subjectExists(id)) throw new HttpError(404, 'not_found', 'Fach nicht gefunden');
    if (deleteSources) {
      const ids = (this.db.prepare('SELECT id FROM sources WHERE subject_id = ? AND parent_id IS NULL').all(id) as { id: number }[]).map((r) => r.id);
      await this.deleteSources(ids);
    }
    this.db.prepare('DELETE FROM subjects WHERE id = ?').run(id); // FK: ON DELETE SET NULL
    this.bus.emit({ type: 'subjects' });
  }

  /* ------------------------------------------------------------ Quellen */

  getSource(id: number): SourceDTO | null {
    return (this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.id = ?`).get(id) as SourceDTO | undefined) ?? null;
  }

  findBySha(sha256: string): SourceDTO | null {
    return (this.db.prepare(`SELECT ${SOURCE_COLUMNS} FROM sources s WHERE s.sha256 = ?`).get(sha256) as SourceDTO | undefined) ?? null;
  }

  listSources(filter: { subjectId?: number | 'none'; parentId?: number; q?: string; status?: string; limit?: number } = {}): SourceDTO[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.parentId !== undefined) {
      where.push('s.parent_id = ?');
      params.push(filter.parentId);
    } else if (filter.subjectId === 'none') where.push('s.subject_id IS NULL');
    else if (typeof filter.subjectId === 'number') {
      where.push('s.subject_id = ?');
      params.push(filter.subjectId);
    }
    if (filter.q) {
      where.push(`(s.name LIKE ? ESCAPE '\\' OR s.rel_path LIKE ? ESCAPE '\\')`);
      const like = `%${filter.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like);
    }
    if (filter.status) {
      where.push('s.status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT ${SOURCE_COLUMNS} FROM sources s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.imported_at DESC, s.id DESC LIMIT ?`;
    params.push(Math.min(filter.limit ?? 2000, 5000));
    return this.db.prepare(sql).all(...params) as unknown as SourceDTO[];
  }

  chunkPreview(sourceId: number, limit = 30): { id: number; ord: number; text: string; heading: string | null; locKind: string | null; locStart: number | null; locEnd: number | null; locLabel: string | null; embedState: number }[] {
    return this.db
      .prepare(
        `SELECT id, ord, text, heading, loc_kind AS locKind, loc_start AS locStart, loc_end AS locEnd, loc_label AS locLabel, embed_state AS embedState
         FROM chunks WHERE source_id = ? ORDER BY ord LIMIT ?`,
      )
      .all(sourceId, limit) as never;
  }

  /** Quelle (und ggf. Archiv-Inhalte) in ein anderes Fach verschieben. */
  moveSource(id: number, subjectId: number | null): SourceDTO {
    const src = this.getSource(id);
    if (!src) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
    if (subjectId !== null && !this.subjectExists(subjectId)) throw new HttpError(400, 'invalid_subject', 'Fach existiert nicht');
    this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT s.id FROM sources s JOIN tree t ON s.parent_id = t.id)
         UPDATE sources SET subject_id = ? WHERE id IN (SELECT id FROM tree)`,
      )
      .run(id, subjectId);
    const updated = this.getSource(id)!;
    this.bus.emit({ type: 'source', source: updated });
    this.bus.emit({ type: 'subjects' });
    return updated;
  }

  renameSource(id: number, name: string): SourceDTO {
    if (!this.getSource(id)) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
    this.db.prepare('UPDATE sources SET name = ? WHERE id = ?').run(sanitizeFileName(name), id);
    const updated = this.getSource(id)!;
    this.bus.emit({ type: 'source', source: updated });
    return updated;
  }

  /**
   * Konsistentes Löschen: Quelle + Archiv-Kinder + Chunks + FTS-Einträge + Vektoren in EINER Transaktion,
   * danach die Originaldateien. Scheitert das Datei-Löschen (Windows-Dateisperre), räumt die GC beim Start auf.
   */
  async deleteSources(ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const all = this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (SELECT value FROM json_each(?) UNION SELECT s.id FROM sources s JOIN tree t ON s.parent_id = t.id)
         SELECT s.id, s.sha256 FROM sources s WHERE s.id IN (SELECT id FROM tree)`,
      )
      .all(jsonList(ids)) as { id: number; sha256: string }[];
    if (!all.length) return 0;
    this.beforeDelete(all.map((r) => r.id));
    tx(this.db, () => {
      const list = jsonList(all.map((r) => r.id));
      this.db.prepare('DELETE FROM embeddings WHERE source_id IN (SELECT value FROM json_each(?))').run(list);
      this.db.prepare('DELETE FROM chunks WHERE source_id IN (SELECT value FROM json_each(?))').run(list);
      this.db.prepare('DELETE FROM sources WHERE id IN (SELECT value FROM json_each(?))').run(list);
    });
    this.vectors.invalidate();
    for (const r of all) {
      // gleicher Inhalt könnte inzwischen erneut importiert worden sein -> Datei dann behalten
      if (!this.findBySha(r.sha256)) await this.blobs.delete(r.sha256);
    }
    for (const r of all) this.bus.emit({ type: 'source-deleted', id: r.id });
    this.bus.emit({ type: 'subjects' });
    return all.length;
  }

  /** Verwaiste Originaldateien (z. B. nach Absturz oder gesperrter Datei) entfernen. */
  async gcOrphanBlobs(): Promise<number> {
    const known = new Set((this.db.prepare('SELECT sha256 FROM sources').all() as { sha256: string }[]).map((r) => r.sha256));
    let removed = 0;
    for (const h of this.blobs.listHashes()) {
      if (!known.has(h) && (await this.blobs.delete(h))) removed++;
    }
    return removed;
  }

  stats(): { subjects: number; sources: number; chunks: number; vectors: number; bytes: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n ?? 0;
    return {
      subjects: one('SELECT count(*) AS n FROM subjects'),
      sources: one('SELECT count(*) AS n FROM sources'),
      chunks: one('SELECT count(*) AS n FROM chunks'),
      vectors: one('SELECT count(*) AS n FROM embeddings'),
      bytes: one('SELECT coalesce(sum(size), 0) AS n FROM sources'),
    };
  }
}
