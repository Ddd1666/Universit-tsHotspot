import path from 'node:path';
import type { Readable } from 'node:stream';
import { tx, type DB } from '../db.ts';
import type { EventBus } from '../events.ts';
import type { BlobStore } from '../storage.ts';
import type { SettingsStore } from '../settings.ts';
import { HttpError, sanitizeFileName, sanitizeRelPath, type Library, type SourceDTO } from '../library.ts';
import { detectKind, unsupportedReason } from './detect.ts';
import { openZip, ZipSecurityError } from './zip.ts';
import { CancelledError, type ExtractionPool } from './worker-pool.ts';
import { DEFAULT_EXTRACT_LIMITS, type SourceKind } from './types.ts';
import type { ExtractOutput } from './extract-run.ts';

export interface ImportMeta {
  name: string;
  relPath?: string | null;
  subjectId?: number | null;
  batchId?: string | null;
}

export interface ImportResult {
  status: 'created' | 'duplicate';
  source: SourceDTO;
}

interface SourceRow {
  id: number;
  subject_id: number | null;
  sha256: string;
  name: string;
  rel_path: string | null;
  mime: string;
  kind: SourceKind;
  batch_id: string | null;
}

const SKIP_IN_ARCHIVE = /(^|\/)(__MACOSX|\.git|\.svn|node_modules)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)\._/i;

export interface IngestStats {
  queued: number;
  processing: { id: number; name: string }[];
}

/**
 * Import & Verarbeitung. Persistente Queue = sources.status ('queued'); nach Neustart werden
 * unterbrochene Jobs ('processing') wieder eingereiht. Fehler bleiben pro Datei sichtbar.
 */
export class IngestService {
  private stopped = true;
  private loops: Promise<void>[] = [];
  private wakers = new Set<() => void>();
  private active = new Map<number, { cancel: () => void; batchId: string | null; name: string }>();
  private readonly deps: {
    db: DB;
    blobs: BlobStore;
    pool: ExtractionPool;
    settings: SettingsStore;
    bus: EventBus;
    library: Library;
    onChunksStored: () => void;
    /** alte Chunks einer Quelle wurden ersetzt (erneute Verarbeitung) -> Vektor-Cache verwerfen */
    onChunksReplaced: () => void;
    onQueueChange: () => void;
    log: (msg: string, extra?: unknown) => void;
  };

  constructor(deps: IngestService['deps']) {
    this.deps = deps;
    deps.library.beforeDelete = (ids) => {
      for (const id of ids) this.active.get(id)?.cancel();
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const { db } = this.deps;
    const r = db.prepare("UPDATE sources SET status = 'queued' WHERE status = 'processing'").run();
    if (Number(r.changes) > 0) this.deps.log(`${r.changes} unterbrochene Verarbeitung(en) wieder eingereiht`);
    const n = this.deps.settings.get().ingestConcurrency;
    for (let i = 0; i < n; i++) this.loops.push(this.loop());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.active.values()) a.cancel();
    for (const w of this.wakers) w();
    await Promise.all(this.loops);
    this.loops = [];
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  stats(): IngestStats {
    const q = this.deps.db.prepare("SELECT count(*) AS n FROM sources WHERE status = 'queued'").get() as { n: number };
    return { queued: q.n, processing: [...this.active.entries()].map(([id, a]) => ({ id, name: a.name })) };
  }

  /** Upload-Stream speichern (Hash, Dedupe) und Quelle anlegen. Verarbeitung läuft asynchron. */
  async importStream(stream: Readable, meta: ImportMeta): Promise<ImportResult> {
    const { db, blobs, settings, library, bus } = this.deps;
    const s = settings.get();
    const subjectId = meta.subjectId ?? null;
    if (subjectId !== null && !library.subjectExists(subjectId)) throw new HttpError(400, 'invalid_subject', 'Fach existiert nicht');
    const name = sanitizeFileName(meta.name);
    const relPath = sanitizeRelPath(meta.relPath);
    const put = await blobs.putStream(stream, s.maxFileSizeMB * 1024 * 1024);
    const dup = library.findBySha(put.sha256);
    if (dup) return { status: 'duplicate', source: dup };
    const det = detectKind(name, put.head);
    const reason = unsupportedReason(det.kind);
    const r = db
      .prepare(
        `INSERT INTO sources(subject_id, parent_id, sha256, name, rel_path, size, mime, kind, status, status_detail, batch_id, imported_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(subjectId, put.sha256, name, relPath, put.size, det.mime, det.kind, reason ? 'unsupported' : 'queued', reason, meta.batchId ?? null, Date.now());
    const source = library.getSource(Number(r.lastInsertRowid))!;
    bus.emit({ type: 'source', source });
    bus.emit({ type: 'subjects' });
    this.deps.onQueueChange();
    this.wake();
    return { status: 'created', source };
  }

  /** Alle noch nicht verarbeiteten Dateien eines Import-Vorgangs abbrechen (gespeichert bleiben sie). */
  cancelBatch(batchId: string): number {
    const { db, bus, library } = this.deps;
    const rows = db.prepare("SELECT id FROM sources WHERE batch_id = ? AND status = 'queued'").all(batchId) as { id: number }[];
    db.prepare("UPDATE sources SET status = 'cancelled', status_detail = NULL WHERE batch_id = ? AND status = 'queued'").run(batchId);
    let n = rows.length;
    for (const [, a] of this.active) {
      if (a.batchId === batchId) {
        a.cancel();
        n++;
      }
    }
    for (const r of rows) bus.emit({ type: 'source', source: library.getSource(r.id) });
    this.deps.onQueueChange();
    return n;
  }

  retry(id: number): SourceDTO {
    const { db, library, bus } = this.deps;
    const src = library.getSource(id);
    if (!src) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
    if (!['error', 'cancelled', 'ready'].includes(src.status)) throw new HttpError(409, 'not_retryable', 'Quelle kann nicht erneut verarbeitet werden');
    db.prepare("UPDATE sources SET status = 'queued', status_detail = NULL WHERE id = ?").run(id);
    const updated = library.getSource(id)!;
    bus.emit({ type: 'source', source: updated });
    this.wake();
    return updated;
  }

  private claimNext(): SourceRow | null {
    const row = this.deps.db
      .prepare(
        `UPDATE sources SET status = 'processing', status_detail = NULL
         WHERE id = (SELECT id FROM sources WHERE status = 'queued' ORDER BY id LIMIT 1)
         RETURNING id, subject_id, sha256, name, rel_path, mime, kind, batch_id`,
      )
      .get() as SourceRow | undefined;
    return row ?? null;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const row = this.claimNext();
      if (!row) {
        await new Promise<void>((resolve) => {
          const w = () => {
            this.wakers.delete(w);
            resolve();
          };
          this.wakers.add(w);
        });
        continue;
      }
      this.emitSource(row.id);
      this.deps.onQueueChange();
      try {
        if (row.kind === 'zip') await this.expandZip(row);
        else await this.extract(row);
      } catch (err) {
        const cancelled = err instanceof CancelledError;
        if (!cancelled) this.deps.log(`Verarbeitung fehlgeschlagen: ${row.name}`, (err as Error).message);
        this.setStatus(row.id, cancelled ? 'cancelled' : 'error', cancelled ? null : (err as Error).message.slice(0, 500));
      } finally {
        this.active.delete(row.id);
        this.emitSource(row.id);
        this.deps.onQueueChange();
      }
    }
  }

  private setStatus(id: number, status: string, detail: string | null): void {
    this.deps.db.prepare('UPDATE sources SET status = ?, status_detail = ?, processed_at = ? WHERE id = ?').run(status, detail, Date.now(), id);
  }

  private emitSource(id: number): void {
    const s = this.deps.library.getSource(id);
    if (s) this.deps.bus.emit({ type: 'source', source: s });
  }

  private async extract(row: SourceRow): Promise<void> {
    const { blobs, pool } = this.deps;
    const handle = pool.run(
      { path: blobs.pathFor(row.sha256), name: row.name, ext: path.extname(row.name).slice(1).toLowerCase(), mime: row.mime, kind: row.kind },
      DEFAULT_EXTRACT_LIMITS,
    );
    this.active.set(row.id, { cancel: handle.cancel, batchId: row.batch_id, name: row.name });
    const out = await handle.promise;
    this.storeChunks(row.id, out);
  }

  /** Chunks atomar speichern (FTS-Trigger aktualisieren den Volltextindex automatisch). */
  storeChunks(sourceId: number, out: ExtractOutput): void {
    const { db } = this.deps;
    const stored = tx(db, () => {
      const exists = db.prepare("SELECT 1 FROM sources WHERE id = ? AND status = 'processing'").get(sourceId);
      if (!exists) return false; // zwischenzeitlich gelöscht/abgebrochen
      const old = db.prepare('DELETE FROM embeddings WHERE source_id = ?').run(sourceId);
      db.prepare('DELETE FROM chunks WHERE source_id = ?').run(sourceId);
      if (Number(old.changes) > 0) this.deps.onChunksReplaced();
      const ins = db.prepare(
        `INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, loc_label, token_est, embed_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      );
      out.chunks.forEach((c, i) => ins.run(sourceId, i, c.text, c.heading, c.locKind, c.locStart, c.locEnd, c.locLabel, c.tokenEst));
      const detail = out.chunks.length === 0 ? 'no_text' : out.warnings.filter((w) => w !== 'no_text').join(',') || null;
      db.prepare("UPDATE sources SET status = 'ready', status_detail = ?, chunk_count = ?, page_count = ?, processed_at = ? WHERE id = ?").run(
        detail,
        out.chunks.length,
        out.pages,
        Date.now(),
        sourceId,
      );
      return true;
    });
    if (stored && out.chunks.length) this.deps.onChunksStored();
  }

  private async expandZip(row: SourceRow): Promise<void> {
    const { blobs, settings, library, db, bus } = this.deps;
    const s = settings.get();
    const maxEntryBytes = s.maxFileSizeMB * 1024 * 1024;
    let cancelled = false;
    this.active.set(row.id, { cancel: () => (cancelled = true), batchId: row.batch_id, name: row.name });
    const zip = await openZip(blobs.pathFor(row.sha256), {
      maxEntries: s.zipMaxEntries,
      maxTotalBytes: s.zipMaxTotalMB * 1024 * 1024,
      maxEntryBytes,
      maxRatio: 1000,
    });
    const summary = { files: 0, duplicates: 0, skipped: 0, failed: 0 };
    const insert = db.prepare(
      `INSERT INTO sources(subject_id, parent_id, sha256, name, rel_path, size, mime, kind, status, status_detail, batch_id, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const entry of zip.entries) {
        if (cancelled || this.stopped) throw new CancelledError();
        if (entry.isDir) continue;
        if (SKIP_IN_ARCHIVE.test(entry.name) || entry.isSymlink || entry.encrypted || entry.size > maxEntryBytes) {
          summary.skipped++;
          continue;
        }
        let put;
        try {
          put = await blobs.putStream(await zip.openStream(entry, maxEntryBytes), maxEntryBytes);
        } catch (err) {
          if (err instanceof ZipSecurityError) throw err; // Bombe -> ganzes Archiv abbrechen
          summary.failed++;
          continue;
        }
        if (library.findBySha(put.sha256)) {
          summary.duplicates++;
          continue;
        }
        const name = sanitizeFileName(entry.name);
        const det = detectKind(name, put.head);
        const reason = det.kind === 'zip' ? 'nested_archive' : unsupportedReason(det.kind);
        const r = insert.run(
          row.subject_id,
          row.id,
          put.sha256,
          name,
          sanitizeRelPath(entry.name),
          put.size,
          det.mime,
          det.kind,
          reason ? 'unsupported' : 'queued',
          reason,
          row.batch_id,
          Date.now(),
        );
        summary.files++;
        const child = library.getSource(Number(r.lastInsertRowid));
        if (child) bus.emit({ type: 'source', source: child });
        this.wake();
      }
    } finally {
      zip.close();
    }
    db.prepare("UPDATE sources SET status = 'archive', status_detail = ?, processed_at = ? WHERE id = ?").run(JSON.stringify(summary), Date.now(), row.id);
    bus.emit({ type: 'subjects' }); // Zähler aktualisieren
  }
}
