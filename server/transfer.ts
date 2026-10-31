import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import { APP_VERSION } from './config.ts';
import { tx, type DB } from './db.ts';
import { HttpError, sanitizeFileName, sanitizeRelPath } from './library.ts';
import type { BlobStore } from './storage.ts';
import { detectKind, unsupportedReason } from './ingest/detect.ts';
import { estimateTokens } from './ingest/chunker.ts';
import { openZip, ZipSecurityError, type ZipEntry } from './ingest/zip.ts';

/**
 * Export/Import einer Bibliothek oder eines Fachs als ZIP (Format: README „Export-Format“).
 *   manifest.json   { format: 'uni-hotspot-export', formatVersion: 1, appVersion, createdAt, scope, counts }
 *   files/<sha256>  Originaldateien (unkomprimiert)
 *   library.jsonl   eine JSON-Zeile je Datensatz: subject, source, chunk, note, card (mit Wiederholungen), question
 * Nicht enthalten: Chats, Vektoren (werden neu berechnet), Quiz-Verlauf, Wissensgraph, Einstellungen.
 * Komplette 1:1-Kopie = Sicherung/Wiederherstellung.
 *
 * Import ist ein gefährlicher Pfad: Eintragsnamen werden nie als Dateipfade benutzt (Zip-Slip unmöglich), Symlinks/
 * verschlüsselte Einträge -> Abbruch, Limits gegen Zip-Bomben (wie beim ZIP-Import, plus Zählung der entpackten Bytes),
 * Dateiinhalt muss zum SHA-256-Namen passen, Format/Typ wird aus dem Inhalt neu erkannt, alle Felder validiert und
 * begrenzt, SQL parametrisiert. Dedupe: Quellen per SHA-256, Fächer per Name, Karten/Notizen per Inhalt, Fragen per Fingerabdruck.
 */

export const EXPORT_FORMAT = 'uni-hotspot-export';
const SHA_RE = /^[0-9a-f]{64}$/;
const MAX_LINE = 8 * 1024 * 1024;

/* ============================================================ ZIP schreiben (unkomprimiert, streamend, ZIP64 bei Bedarf) */

interface CdEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipWriter {
  private offset = 0;
  private readonly entries: CdEntry[] = [];
  private readonly out: Writable;
  private readonly limit: number;
  private readonly when = dosTime(new Date());

  /** `zip64Threshold` nur für Tests (ZIP64-Pfad ohne 4-GB-Dateien prüfen) */
  constructor(out: Writable, opts: { zip64Threshold?: number } = {}) {
    this.out = out;
    this.limit = opts.zip64Threshold ?? 0xfffffffe;
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.out.destroyed) throw Object.assign(new Error('Ausgabe geschlossen'), { code: 'ERR_STREAM_DESTROYED' });
    this.offset += buf.length;
    // auf "drain" ODER "close" warten: bricht der Download ab, käme "drain" nie und der Export hinge für immer
    if (!this.out.write(buf)) await Promise.race([once(this.out, 'drain'), once(this.out, 'close')]);
    if (this.out.destroyed) throw Object.assign(new Error('Ausgabe geschlossen'), { code: 'ERR_STREAM_DESTROYED' });
  }

  /** Eintrag mit bekannter Größe; Daten kommen als Stream oder Buffer. */
  async add(name: string, size: number, data: Readable | Buffer): Promise<void> {
    const nameBuf = Buffer.from(name, 'utf8');
    const zip64 = size > this.limit || this.offset > this.limit;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(zip64 ? 45 : 20, 4);
    h.writeUInt16LE(0x0808, 6); // Datendeskriptor + UTF-8-Namen
    h.writeUInt16LE(0, 8); // gespeichert
    h.writeUInt16LE(this.when.time, 10);
    h.writeUInt16LE(this.when.date, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2); // Größen 0 (stehen im Deskriptor)
    }
    h.writeUInt16LE(extra.length, 28);
    const offset = this.offset;
    await this.write(Buffer.concat([h, nameBuf, extra]));
    let crc = 0;
    let written = 0;
    const chunks = Buffer.isBuffer(data) ? [data] : data;
    for await (const c of chunks as AsyncIterable<Buffer> | Buffer[]) {
      crc = zlib.crc32(c, crc);
      written += c.length;
      if (written > size) throw new Error('Datei während des Exports gewachsen');
      await this.write(c);
    }
    if (written !== size) throw new Error('Datei während des Exports verändert');
    const dd = Buffer.alloc(zip64 ? 24 : 16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    if (zip64) {
      dd.writeBigUInt64LE(BigInt(size), 8);
      dd.writeBigUInt64LE(BigInt(size), 16);
    } else {
      dd.writeUInt32LE(size, 8);
      dd.writeUInt32LE(size, 12);
    }
    await this.write(dd);
    this.entries.push({ name: nameBuf, crc, size, offset, zip64: zip64 || offset > this.limit });
  }

  async finish(): Promise<void> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const big = e.zip64 || e.size > this.limit || e.offset > this.limit;
      const extra = big ? Buffer.alloc(28) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4);
        extra.writeBigUInt64LE(BigInt(e.size), 12);
        extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(big ? 45 : 20, 4);
      c.writeUInt16LE(big ? 45 : 20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.when.time, 12);
      c.writeUInt16LE(this.when.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(big ? 0xffffffff : e.size, 20);
      c.writeUInt32LE(big ? 0xffffffff : e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt32LE(big ? 0xffffffff : e.offset, 42);
      await this.write(Buffer.concat([c, e.name, extra]));
    }
    const cdSize = this.offset - cdStart;
    const needs64 = this.entries.length > 0xfffe || cdStart > this.limit || cdSize > this.limit || this.entries.some((e) => e.zip64);
    if (needs64) {
      const z = Buffer.alloc(56);
      const zOffset = this.offset;
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(this.entries.length), 24);
      z.writeBigUInt64LE(BigInt(this.entries.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeBigUInt64LE(BigInt(zOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([z, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(needs64 ? 0xffff : this.entries.length, 8);
    end.writeUInt16LE(needs64 ? 0xffff : this.entries.length, 10);
    end.writeUInt32LE(needs64 ? 0xffffffff : cdSize, 12);
    end.writeUInt32LE(needs64 ? 0xffffffff : cdStart, 16);
    await this.write(end);
    this.out.end();
  }
}

/* ============================================================ Export */

export type ExportScope = { kind: 'all' } | { kind: 'subject'; id: number };

/** Zeilenpuffer für library.jsonl (Temp-Datei: Größe muss vor dem ZIP-Eintrag bekannt sein). */
async function writeJsonl(file: string, produce: (emit: (rec: object) => Promise<void>) => Promise<void>): Promise<void> {
  const ws = fs.createWriteStream(file);
  let failed: Error | null = null;
  // Schreibfehler (Platte voll …) als Fehler weitergeben statt unbehandeltem "error"-Ereignis
  ws.on('error', (err) => (failed = err));
  const emit = async (rec: object) => {
    if (failed) throw failed;
    if (!ws.write(JSON.stringify(rec) + '\n')) await Promise.race([once(ws, 'drain'), once(ws, 'close')]);
  };
  try {
    await produce(emit);
  } finally {
    ws.end();
    await finished(ws).catch(() => {});
  }
  if (failed) throw failed;
}

interface ExportCounts {
  subjects: number;
  sources: number;
  chunks: number;
  notes: number;
  cards: number;
  questions: number;
  files: number;
}

/**
 * Schreibt den Export als ZIP nach `out`. Große Abfragen laufen zeilenweise (iterate) und geben den Event-Loop
 * regelmäßig frei. `tmpDir` nimmt die JSONL-Zwischendatei auf.
 */
export async function writeExport(db: DB, blobs: BlobStore, scope: ExportScope, out: Writable, tmpDir: string, opts: { zip64Threshold?: number } = {}): Promise<ExportCounts> {
  const sub = scope.kind === 'subject' ? scope.id : null;
  if (sub !== null && !db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(sub)) throw new HttpError(404, 'not_found', 'Fach nicht gefunden');
  const counts: ExportCounts = { subjects: 0, sources: 0, chunks: 0, notes: 0, cards: 0, questions: 0, files: 0 };
  const jsonl = path.join(tmpDir, `export-${process.pid}-${Date.now()}.jsonl`);
  await fsp.mkdir(tmpDir, { recursive: true });
  const srcWhere = sub === null ? '' : 'WHERE subject_id = ?';
  const args = sub === null ? [] : [sub];
  const inScope = new Set<number>();
  const chunkOrd = db.prepare('SELECT source_id, ord FROM chunks WHERE id = ?');
  const ref = (sourceId: number | null, chunkId: number | null) => {
    if (sourceId === null || !inScope.has(sourceId)) return { source: null, chunkOrd: null };
    const c = chunkId !== null ? (chunkOrd.get(chunkId) as { source_id: number; ord: number } | undefined) : undefined;
    return { source: sourceId, chunkOrd: c && c.source_id === sourceId ? c.ord : null };
  };
  let n = 0;
  const yieldSometimes = async () => {
    if (++n % 500 === 0) await new Promise((r) => setImmediate(r));
  };
  const shas: { sha: string; size: number }[] = [];
  try {
    await writeJsonl(jsonl, async (emit) => {
      for (const s of db.prepare(`SELECT id, name, color FROM subjects ${sub === null ? '' : 'WHERE id = ?'} ORDER BY id`).all(...args) as { id: number; name: string; color: string }[]) {
        await emit({ t: 'subject', key: s.id, name: s.name, color: s.color });
        counts.subjects++;
      }
      const chunkStmt = db.prepare('SELECT ord, text, heading, loc_kind, loc_start, loc_end, loc_label, origin FROM chunks WHERE source_id = ? ORDER BY ord');
      for (const s of db.prepare(`SELECT * FROM sources ${srcWhere} ORDER BY id`).all(...args) as Record<string, unknown>[]) {
        const file = blobs.pathFor(String(s.sha256));
        let size: number;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue; // Originaldatei fehlt -> Quelle nicht exportierbar
        }
        inScope.add(Number(s.id));
        shas.push({ sha: String(s.sha256), size });
        await emit({
          t: 'source',
          key: s.id,
          subject: s.subject_id,
          parent: s.parent_id !== null && inScope.has(Number(s.parent_id)) ? s.parent_id : null,
          sha256: s.sha256,
          name: s.name,
          relPath: s.rel_path,
          kind: s.kind,
          status: s.status,
          statusDetail: s.status_detail,
          pageCount: s.page_count,
          importedAt: s.imported_at,
        });
        counts.sources++;
        for (const c of chunkStmt.iterate(s.id as number) as Iterable<Record<string, unknown>>) {
          await emit({ t: 'chunk', source: s.id, ord: c.ord, text: c.text, heading: c.heading, loc: [c.loc_kind, c.loc_start, c.loc_end, c.loc_label], origin: c.origin });
          counts.chunks++;
          await yieldSometimes();
        }
        await yieldSometimes();
      }
      for (const r of db.prepare(`SELECT * FROM notes ${srcWhere} ORDER BY id`).all(...args) as Record<string, unknown>[]) {
        let cites: { n?: unknown; chunkId?: unknown; sourceId?: unknown; sourceName?: unknown; loc?: unknown; heading?: unknown }[] = [];
        try {
          cites = JSON.parse(String(r.citations)) as typeof cites;
        } catch {
          /* leer */
        }
        await emit({
          t: 'note',
          title: r.title,
          body: r.body,
          level: r.level,
          scope: r.scope,
          subject: r.subject_id,
          ai: r.ai,
          edited: r.edited,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          citations: (Array.isArray(cites) ? cites : []).map((c) => ({ n: c.n, ...ref(typeof c.sourceId === 'number' ? c.sourceId : null, typeof c.chunkId === 'number' ? c.chunkId : null), sourceName: c.sourceName, loc: c.loc, heading: c.heading })),
        });
        counts.notes++;
      }
      const reviews = db.prepare('SELECT rating, reviewed_at, interval_days, ease FROM reviews WHERE card_id = ? ORDER BY id');
      for (const r of db.prepare(`SELECT * FROM cards ${srcWhere} ORDER BY id`).iterate(...args) as Iterable<Record<string, unknown>>) {
        await emit({
          t: 'card',
          type: r.type,
          front: r.front,
          back: r.back,
          status: r.status,
          ai: r.ai,
          subject: r.subject_id,
          ...ref(r.source_id as number | null, r.chunk_id as number | null),
          sourceName: r.source_name,
          loc: r.loc,
          reps: r.reps,
          ease: r.ease,
          intervalDays: r.interval_days,
          lapses: r.lapses,
          due: r.due,
          lastReview: r.last_review,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          reviews: (reviews.all(r.id as number) as { rating: number; reviewed_at: number; interval_days: number; ease: number }[]).map((v) => [v.rating, v.reviewed_at, v.interval_days, v.ease]),
        });
        counts.cards++;
        await yieldSometimes();
      }
      for (const r of db.prepare(`SELECT * FROM quiz_questions ${srcWhere} ORDER BY id`).iterate(...args) as Iterable<Record<string, unknown>>) {
        await emit({
          t: 'question',
          type: r.type,
          question: r.question,
          options: r.options,
          answer: r.answer,
          explanation: r.explanation,
          topic: r.topic,
          fingerprint: r.fingerprint,
          subject: r.subject_id,
          ...ref(r.source_id as number | null, r.chunk_id as number | null),
          sourceName: r.source_name,
          loc: r.loc,
          createdAt: r.created_at,
        });
        counts.questions++;
        await yieldSometimes();
      }
    });
    const subjectName = sub !== null ? (db.prepare('SELECT name FROM subjects WHERE id = ?').get(sub) as { name: string }).name : null;
    const zip = new ZipWriter(out, opts);
    const manifest = Buffer.from(JSON.stringify({ format: EXPORT_FORMAT, formatVersion: 1, appVersion: APP_VERSION, createdAt: Date.now(), scope: { kind: scope.kind, name: subjectName }, counts }, null, 2));
    await zip.add('manifest.json', manifest.length, manifest);
    const seen = new Set<string>();
    for (const f of shas) {
      if (seen.has(f.sha)) continue;
      seen.add(f.sha);
      await zip.add(`files/${f.sha}`, f.size, fs.createReadStream(blobs.pathFor(f.sha)));
      counts.files++;
    }
    await zip.add('library.jsonl', fs.statSync(jsonl).size, fs.createReadStream(jsonl));
    await zip.finish();
    return counts;
  } finally {
    await fsp.rm(jsonl, { force: true });
  }
}

/* ============================================================ Import */

export interface ImportReport {
  subjects: { created: number; merged: number };
  sources: { added: number; duplicate: number; skipped: number; requeued: number };
  files: { added: number; existing: number; invalid: number };
  chunks: number;
  notes: { added: number; duplicate: number };
  cards: { added: number; duplicate: number };
  questions: { added: number; duplicate: number };
  skippedRecords: number;
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Zeitstempel (ms) nur im Bereich, den Date darstellen kann (0 … 8,64e15), sonst null */
const tsOrNull = (v: unknown): number | null => {
  const n = int(v);
  return n !== null && n >= 0 && n <= 8.64e15 ? n : null;
};
/** Schlüssel für Dedupe im Speicher (statt einer Abfrage je Datensatz über ungeindexte Textspalten) */
const dedupeKey = (...parts: string[]) => crypto.createHash('sha1').update(parts.join('\u0000')).digest('base64');

/** Positionsangabe als JSON-Text (Karten/Fragen) – nur bekannte Felder. */
function cleanLoc(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000) return null;
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    const out: Record<string, unknown> = { k: str(o.k, 20), s: num(o.s), e: num(o.e), l: str(o.l, 200) };
    if (int(o.chat) !== null) Object.assign(out, { chat: null, t: str(o.t, 200) }); // Chat-Bezug gilt nur in der Ursprungs-DB
    return JSON.stringify(out);
  } catch {
    return null;
  }
}

/** Liest Textzeilen aus einem Stream – mit Obergrenze je Zeile (keine Speicher-Bombe durch eine Riesenzeile). */
async function* lines(stream: Readable): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += (chunk as Buffer).toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
    if (buf.length > MAX_LINE) throw new HttpError(400, 'import_invalid', 'Datensatz zu groß', 'line');
  }
  if (buf.trim()) yield buf;
}

export interface ImportDeps {
  db: DB;
  blobs: BlobStore;
}

/**
 * Importiert eine Export-Datei. Quellen ohne passenden Inhalt/Typ werden zur Verarbeitung eingereiht (Rückgabe
 * `sources.requeued` > 0 -> Ingest wecken). Vektoren berechnet die Embedding-Queue nach.
 */
export async function importLibrary(deps: ImportDeps, zipPath: string, opts: { failAfterBatch?: number } = {}): Promise<ImportReport> {
  try {
    return await doImport(deps, zipPath, opts);
  } catch (err) {
    // Zip-Slip/-Bombe/kaputtes Archiv (auch erst beim Entpacken erkannt) -> ein Code, Detail = Grund
    if (err instanceof ZipSecurityError) throw new HttpError(400, 'import_invalid', 'Keine gültige Export-Datei', err.code);
    throw err;
  }
}

async function doImport(deps: ImportDeps, zipPath: string, opts: { failAfterBatch?: number }): Promise<ImportReport> {
  const { db, blobs } = deps;
  const zipSize = fs.statSync(zipPath).size;
  const report: ImportReport = {
    subjects: { created: 0, merged: 0 },
    sources: { added: 0, duplicate: 0, skipped: 0, requeued: 0 },
    files: { added: 0, existing: 0, invalid: 0 },
    chunks: 0,
    notes: { added: 0, duplicate: 0 },
    cards: { added: 0, duplicate: 0 },
    questions: { added: 0, duplicate: 0 },
    skippedRecords: 0,
  };
  let zip;
  try {
    zip = await openZip(zipPath, {
      maxEntries: 500_000,
      // unkomprimierter Export: entpackt ≈ Dateigröße; Spielraum für nachträglich komprimierte Archive
      maxTotalBytes: Math.min(64 * 1024 ** 3, Math.max(1024 ** 3, zipSize * 50)),
      maxEntryBytes: 16 * 1024 ** 3,
      maxRatio: 200,
    });
  } catch (err) {
    throw new HttpError(400, 'import_invalid', 'Keine gültige Export-Datei', err instanceof ZipSecurityError ? err.code : 'zip');
  }
  try {
    const byName = new Map<string, ZipEntry>();
    for (const e of zip.entries) {
      if (e.isSymlink || e.encrypted) throw new HttpError(400, 'import_invalid', 'Export enthält Verweise oder verschlüsselte Einträge', 'entry');
      if (!e.isDir) byName.set(e.name, e);
    }
    const manEntry = byName.get('manifest.json');
    const libEntry = byName.get('library.jsonl');
    if (!manEntry || !libEntry || manEntry.size > 64 * 1024) throw new HttpError(400, 'import_invalid', 'Keine Uni-Hotspot-Export-Datei', 'manifest');
    let manifest: { format?: unknown; formatVersion?: unknown };
    try {
      const parts: Buffer[] = [];
      for await (const c of await zip.openStream(manEntry, 64 * 1024)) parts.push(c as Buffer);
      manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as typeof manifest;
    } catch {
      throw new HttpError(400, 'import_invalid', 'Keine Uni-Hotspot-Export-Datei', 'manifest');
    }
    if (manifest.format !== EXPORT_FORMAT) throw new HttpError(400, 'import_invalid', 'Keine Uni-Hotspot-Export-Datei', 'manifest');
    if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > 1) throw new HttpError(409, 'import_too_new', 'Export stammt von einer neueren Version', String(manifest.formatVersion));

    // 1) Originaldateien: Name = SHA-256, Inhalt wird beim Speichern gehasht und muss passen
    const okFiles = new Set<string>();
    for (const [name, e] of byName) {
      const m = /^files\/([0-9a-f]{64})$/.exec(name);
      if (!m) continue;
      const sha = m[1]!;
      if (blobs.has(sha)) {
        okFiles.add(sha);
        report.files.existing++;
        continue;
      }
      const put = await blobs.putStream(await zip.openStream(e, e.size), e.size);
      if (put.sha256 !== sha) {
        if (!put.existed && !db.prepare('SELECT 1 FROM sources WHERE sha256 = ?').get(put.sha256)) await blobs.delete(put.sha256);
        report.files.invalid++;
        continue;
      }
      okFiles.add(sha);
      report.files.added++;
    }

    // 2) Datensätze – Schlüssel der Export-DB auf neue IDs abbilden
    const subjectMap = new Map<number, number>();
    const sourceMap = new Map<number, number>();
    const newSources = new Set<number>(); // nur deren Abschnitte werden übernommen
    const chunkCount = new Map<number, number>();
    const existingSubjects = new Map((db.prepare('SELECT id, name FROM subjects').all() as { id: number; name: string }[]).map((s) => [s.name.trim().toLowerCase(), s.id]));
    const chunkId = db.prepare('SELECT id FROM chunks WHERE source_id = ? AND ord = ?');
    const mapRef = (rec: Record<string, unknown>) => {
      const sid = int(rec.source) !== null ? (sourceMap.get(rec.source as number) ?? null) : null;
      const ord = int(rec.chunkOrd);
      const cid = sid !== null && ord !== null ? ((chunkId.get(sid, ord) as { id: number } | undefined)?.id ?? null) : null;
      return { sid, cid };
    };
    const subj = (v: unknown) => (int(v) !== null ? (subjectMap.get(v as number) ?? null) : null);
    const ins = {
      subject: db.prepare('INSERT INTO subjects(name, color, created_at) VALUES (?, ?, ?)'),
      source: db.prepare(
        `INSERT INTO sources(subject_id, parent_id, sha256, name, rel_path, size, mime, kind, status, status_detail, page_count, chunk_count, imported_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      ),
      chunk: db.prepare('INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, loc_label, token_est, embed_state, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'),
      note: db.prepare('INSERT INTO notes(title, body, level, scope, citations, subject_id, ai, edited, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      card: db.prepare(
        `INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, chunk_id, source_name, loc, reps, ease, interval_days, lapses, due, last_review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      review: db.prepare('INSERT INTO reviews(card_id, rating, reviewed_at, interval_days, ease) VALUES (?, ?, ?, ?, ?)'),
      question: db.prepare(
        `INSERT OR IGNORE INTO quiz_questions(type, question, options, answer, explanation, topic, fingerprint, subject_id, source_id, chunk_id, source_name, loc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
    };
    const now = Date.now();
    const ts = (v: unknown) => tsOrNull(v) ?? now;
    // vorhandene Karten/Notizen einmal einlesen: O(1) je Datensatz statt Volltextvergleich über die ganze Tabelle
    // (in Paketen nach ID, damit auch 100 000 Karten den Event-Loop nicht am Stück blockieren)
    const cardKeys = new Set<string>();
    const cardPage = db.prepare('SELECT id, type, front, back FROM cards WHERE id > ? ORDER BY id LIMIT 2000');
    for (let last = 0; ; ) {
      const rows = cardPage.all(last) as { id: number; type: string; front: string; back: string }[];
      for (const r of rows) cardKeys.add(dedupeKey(r.type, r.front, r.back));
      if (rows.length < 2000) break;
      last = rows[rows.length - 1]!.id;
      await new Promise((r) => setImmediate(r));
    }
    const noteKeys = new Set<string>();
    for (const r of db.prepare('SELECT title, body FROM notes').iterate() as Iterable<{ title: string; body: string }>) noteKeys.add(dedupeKey(r.title, r.body));
    /** neue Quellen: Zielstatus erst am Ende setzen – bis dahin 'processing' (Abbruch/Absturz -> beim Start/catch 'queued') */
    const intended = new Map<number, { status: string; processedAt: number | null }>();

    const handle = (rec: Record<string, unknown>): void => {
      switch (rec.t) {
        case 'subject': {
          const key = int(rec.key);
          const name = str(rec.name, 80)?.trim();
          if (key === null || !name) throw new Error('skip');
          const color = typeof rec.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(rec.color) ? rec.color : '#39e6ff';
          const existing = existingSubjects.get(name.toLowerCase());
          if (existing !== undefined) {
            subjectMap.set(key, existing);
            report.subjects.merged++;
          } else {
            const id = Number(ins.subject.run(name, color, now).lastInsertRowid);
            existingSubjects.set(name.toLowerCase(), id);
            subjectMap.set(key, id);
            report.subjects.created++;
          }
          return;
        }
        case 'source': {
          const key = int(rec.key);
          const sha = typeof rec.sha256 === 'string' && SHA_RE.test(rec.sha256) ? rec.sha256 : null;
          if (key === null || !sha) throw new Error('skip');
          const dup = db.prepare('SELECT id FROM sources WHERE sha256 = ?').get(sha) as { id: number } | undefined;
          if (dup) {
            sourceMap.set(key, dup.id);
            report.sources.duplicate++;
            return;
          }
          if (!okFiles.has(sha)) {
            report.sources.skipped++;
            return;
          }
          const name = sanitizeFileName(str(rec.name, 255) ?? 'unbenannt');
          const file = blobs.pathFor(sha);
          const head = Buffer.alloc(8192);
          const fd = fs.openSync(file, 'r');
          let headLen: number;
          try {
            headLen = fs.readSync(fd, head, 0, head.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          // Typ nie aus dem Export übernehmen: aus Inhalt + Name neu erkennen (bestimmt die sichere Auslieferung)
          const det = detectKind(name, head.subarray(0, headLen));
          const reason = det.reason ?? unsupportedReason(det.kind, det.mime);
          const sameKind = det.kind === rec.kind;
          let status: string;
          let detail: string | null = null;
          if (reason) {
            status = 'unsupported';
            detail = reason;
          } else if (sameKind && (rec.status === 'ready' || rec.status === 'archive')) {
            status = rec.status;
            detail = typeof rec.statusDetail === 'string' && /^[a-z_,]{1,200}$/.test(rec.statusDetail) ? rec.statusDetail : null;
          } else {
            status = 'queued';
            report.sources.requeued++;
          }
          const parent = int(rec.parent) !== null ? (sourceMap.get(rec.parent as number) ?? null) : null;
          const processedAt = status === 'queued' ? null : now;
          // bis zum Abschluss 'processing': die Verarbeitung fasst die Quelle nicht an; ein Absturz mittendrin wird beim
          // nächsten Start zu 'queued' (neu verarbeiten) statt halb importiert als „fertig“ zu gelten
          const id = Number(
            ins.source.run(
              subj(rec.subject),
              parent,
              sha,
              name,
              sanitizeRelPath(str(rec.relPath, 1024)),
              fs.statSync(file).size,
              det.mime,
              det.kind,
              status === 'unsupported' ? status : 'processing',
              detail,
              status === 'ready' ? int(rec.pageCount) : null,
              ts(rec.importedAt),
              null,
            ).lastInsertRowid,
          );
          if (status !== 'unsupported') intended.set(id, { status, processedAt });
          sourceMap.set(key, id);
          if (status === 'ready') newSources.add(id);
          report.sources.added++;
          return;
        }
        case 'chunk': {
          const sid = int(rec.source) !== null ? sourceMap.get(rec.source as number) : undefined;
          if (sid === undefined || !newSources.has(sid)) return; // Duplikat/übersprungen: Abschnitte der vorhandenen Quelle gelten
          const text = str(rec.text, 2_000_000);
          const ord = int(rec.ord);
          if (!text || ord === null) throw new Error('skip');
          const loc = Array.isArray(rec.loc) ? rec.loc : [];
          const kinds = ['page', 'slide', 'sheet', 'rows', 'lines', 'section', 'time'];
          const origin = ['ocr', 'vision', 'transcript'].includes(rec.origin as string) ? (rec.origin as string) : null;
          ins.chunk.run(sid, ord, text, str(rec.heading, 500), kinds.includes(loc[0] as string) ? (loc[0] as string) : null, num(loc[1]), num(loc[2]), str(loc[3], 200), estimateTokens(text), origin);
          chunkCount.set(sid, (chunkCount.get(sid) ?? 0) + 1);
          report.chunks++;
          return;
        }
        case 'note': {
          const title = str(rec.title, 200)?.trim();
          const body = str(rec.body, 200_000) ?? '';
          if (!title) throw new Error('skip');
          const nk = dedupeKey(title, body);
          if (noteKeys.has(nk)) {
            report.notes.duplicate++;
            return;
          }
          const cites = (Array.isArray(rec.citations) ? rec.citations : []).slice(0, 500).flatMap((c: Record<string, unknown>) => {
            if (!c || typeof c !== 'object' || int(c.n) === null) return [];
            const { sid, cid } = mapRef(c);
            const l = c.loc as Record<string, unknown> | null;
            const loc = l && typeof l === 'object' ? { k: str(l.k, 20), s: num(l.s), e: num(l.e), l: str(l.l, 200) } : null;
            return [{ n: c.n, chunkId: cid, sourceId: sid, sourceName: str(c.sourceName, 255) ?? '?', loc, heading: str(c.heading, 500) }];
          });
          let scope: Record<string, unknown> = {};
          try {
            const s = JSON.parse(String(rec.scope ?? '{}')) as Record<string, unknown>;
            // nur Anzeige-Hinweise übernehmen, keine IDs der Ursprungs-DB
            for (const k of ['truncated', 'total', 'chunks', 'failed', 'weak']) if (typeof s[k] === 'number' || typeof s[k] === 'boolean') scope[k] = s[k];
          } catch {
            scope = {};
          }
          const level = ['tldr', 'outline', 'detailed', 'cheatsheet'].includes(rec.level as string) ? (rec.level as string) : null;
          ins.note.run(title, body, level, JSON.stringify(scope), JSON.stringify(cites), subj(rec.subject), rec.ai ? 1 : 0, rec.edited ? 1 : 0, ts(rec.createdAt), ts(rec.updatedAt));
          noteKeys.add(nk);
          report.notes.added++;
          return;
        }
        case 'card': {
          const type = ['qa', 'cloze', 'image'].includes(rec.type as string) ? (rec.type as string) : null;
          const status = ['draft', 'active', 'suspended'].includes(rec.status as string) ? (rec.status as string) : null;
          const front = str(rec.front, 2000);
          const back = str(rec.back, 4000);
          if (!type || !status || !front || back === null) throw new Error('skip');
          const ck = dedupeKey(type, front, back);
          if (cardKeys.has(ck)) {
            report.cards.duplicate++;
            return;
          }
          const { sid, cid } = mapRef(rec);
          const ease = num(rec.ease);
          const id = Number(
            ins.card.run(
              type,
              front,
              back,
              status,
              rec.ai ? 1 : 0,
              subj(rec.subject),
              sid,
              cid,
              str(rec.sourceName, 255),
              cleanLoc(rec.loc),
              Math.max(0, int(rec.reps) ?? 0),
              ease !== null && ease >= 1.3 && ease <= 5 ? ease : 2.5,
              Math.max(0, int(rec.intervalDays) ?? 0),
              Math.max(0, int(rec.lapses) ?? 0),
              tsOrNull(rec.due),
              tsOrNull(rec.lastReview),
              ts(rec.createdAt),
              ts(rec.updatedAt),
            ).lastInsertRowid,
          );
          for (const r of (Array.isArray(rec.reviews) ? rec.reviews : []).slice(0, 10_000) as unknown[][]) {
            const rating = Array.isArray(r) ? int(r[0]) : null;
            const at = Array.isArray(r) ? tsOrNull(r[1]) : null;
            if (rating === null || rating < 1 || rating > 4 || at === null) continue;
            ins.review.run(id, rating, at, Math.max(0, int(r[2]) ?? 0), num(r[3]) ?? 2.5);
          }
          cardKeys.add(ck);
          report.cards.added++;
          return;
        }
        case 'question': {
          const type = ['mc', 'tf', 'cloze', 'short'].includes(rec.type as string) ? (rec.type as string) : null;
          const question = str(rec.question, 4000);
          const answer = str(rec.answer, 4000);
          const fp = str(rec.fingerprint, 200);
          if (!type || !question || answer === null || !fp) throw new Error('skip');
          let options: string | null = null;
          if (typeof rec.options === 'string') {
            try {
              const o = JSON.parse(rec.options) as unknown;
              if (Array.isArray(o) && o.length <= 10 && o.every((x) => typeof x === 'string' && x.length <= 1000)) options = JSON.stringify(o);
            } catch {
              options = null;
            }
          }
          const { sid, cid } = mapRef(rec);
          const r = ins.question.run(type, question, options, answer, str(rec.explanation, 4000), str(rec.topic, 200), fp, subj(rec.subject), sid, cid, str(rec.sourceName, 255), cleanLoc(rec.loc), ts(rec.createdAt));
          if (Number(r.changes)) report.questions.added++;
          else report.questions.duplicate++;
          return;
        }
        default:
          throw new Error('skip');
      }
    };

    // Pakete à 300 Datensätze je Transaktion, dazwischen Event-Loop frei (node:sqlite ist synchron)
    let batch: Record<string, unknown>[] = [];
    const flush = () => {
      tx(db, () => {
        for (const rec of batch) {
          try {
            tx(db, () => handle(rec));
          } catch {
            report.skippedRecords++;
          }
        }
      });
      batch = [];
    };
    try {
      let batches = 0;
      for await (const line of lines(await zip.openStream(libEntry, libEntry.size))) {
        if (!line.trim()) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          report.skippedRecords++;
          continue;
        }
        if (!rec || typeof rec !== 'object') {
          report.skippedRecords++;
          continue;
        }
        batch.push(rec as Record<string, unknown>);
        if (batch.length >= 150) {
          flush();
          if (++batches === opts.failAfterBatch) throw new Error('Test: Abbruch nach Paket');
          await new Promise((r) => setImmediate(r));
        }
      }
      flush();
    } catch (err) {
      // Abbruch mittendrin (kaputte Datei, Platte voll …): bereits angelegte Quellen neu verarbeiten lassen – nie „halb fertig“
      tx(db, () => {
        const q = db.prepare("UPDATE sources SET status = 'queued', processed_at = NULL WHERE id = ? AND status = 'processing'");
        for (const id of intended.keys()) q.run(id);
      });
      throw err;
    }
    // Abschluss: Abschnittszahl + Zielstatus; Quellen ohne Abschnitte (Export unvollständig) neu verarbeiten
    tx(db, () => {
      const setDone = db.prepare('UPDATE sources SET status = ?, chunk_count = ?, processed_at = ? WHERE id = ?');
      for (const [id, want] of intended) {
        const n = chunkCount.get(id) ?? 0;
        if (want.status === 'ready' && !n) {
          setDone.run('queued', 0, null, id);
          report.sources.requeued++;
        } else setDone.run(want.status, n, want.processedAt, id);
      }
    });
    return report;
  } finally {
    zip.close();
  }
}
