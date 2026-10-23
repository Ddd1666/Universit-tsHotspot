import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { tx, type DB } from '../db.ts';
import type { EventBus } from '../events.ts';
import type { BlobStore } from '../storage.ts';
import type { SettingsStore } from '../settings.ts';
import type { Library } from '../library.ts';
import type { Scheduler } from '../scheduler.ts';
import { OllamaError, type OllamaClient } from '../ollama/client.ts';
import { chunkBlocks } from '../ingest/chunker.ts';
import { codedError, type ChunkDraft, type TextBlock } from '../ingest/types.ts';
import type { ExtractOutput } from '../ingest/extract-run.ts';
import { imageSize } from './image.ts';
import type { PageImage, PageImageRequest } from './page-image-worker.ts';
import { analyzeImage, type VisionKind, type VisionResult } from './vision.ts';
import { resolveTools, type ToolOverrides } from './tools.ts';
import {
  DEFAULT_TIMEOUTS,
  extractFrame,
  extractSegment,
  keepEntries,
  parseWhisperJson,
  probe,
  SEGMENT_SEC,
  segmentWindow,
  transcribeSegment,
  type MediaTimeouts,
  type TranscriptEntry,
} from './audio.ts';

export type MediaJobKind = 'image' | 'scan' | 'audio' | 'video';
export type MediaJobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface MediaJobDTO {
  id: number;
  sourceId: number;
  sourceName: string;
  kind: MediaJobKind;
  state: MediaJobState;
  progress: number;
  total: number | null;
  detail: string | null;
  /** nur laufende Jobs: worauf gerade gewartet wird */
  note: 'waiting_ollama' | 'waiting_chat' | null;
  etaSec: number | null;
  createdAt: number;
  updatedAt: number;
}

interface JobRow {
  id: number;
  source_id: number;
  kind: MediaJobKind;
  state: MediaJobState;
  progress: number;
  total: number | null;
  detail: string | null;
  params: string | null;
  created_at: number;
  updated_at: number;
}

interface SourceRow {
  id: number;
  sha256: string;
  name: string;
  kind: string;
  mime: string;
  status: string;
}

interface Active {
  ctrl: AbortController;
  sourceId: number;
  userCancelled: boolean;
  startedAt: number;
  startProgress: number;
  note: MediaJobDTO['note'];
  lastEmit: number;
}

/** Größere Bilddateien gehen nicht an das Vision-Modell (Base64 im Request, Event-Loop). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Dekompressionsbomben: Abmessungen werden vor jeder Verarbeitung aus dem Dateikopf gelesen. */
export const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_KEYFRAMES = 12;
const MAX_EMBEDDED_IMAGES = 30;
const MAX_EMBEDDED_PAGES = 100;
const EMBEDDED_BASE = 100_000;
const KEYFRAME_BASE = 100_000;
const LANES: Record<'vision' | 'audio', MediaJobKind[]> = { vision: ['image', 'scan'], audio: ['audio', 'video'] };

export interface MediaDeps {
  db: DB;
  blobs: BlobStore;
  settings: SettingsStore;
  bus: EventBus;
  library: Library;
  client: OllamaClient;
  scheduler: Scheduler;
  toolsDir: string;
  toolOverrides?: ToolOverrides;
  timeouts?: Partial<MediaTimeouts>;
  /** Chunks einer Quelle ersetzen (IngestService.storeChunks) */
  storeChunks: (sourceId: number, out: ExtractOutput, isCancelled: () => boolean, expectStatus: string) => Promise<void>;
  onChunksStored: () => void;
  onChunksReplaced: () => void;
  log: (msg: string, extra?: unknown) => void;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(codedError('abgebrochen', 'media_cancelled'));
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

const isCancel = (err: unknown) => (err as { code?: string })?.code === 'media_cancelled' || (err as { name?: string })?.name === 'AbortError';

/**
 * Persistente, neustartfeste Medien-Queue (Bilder, Scan-Seiten, Audio/Video):
 * - Zustand in `media_jobs`, Zwischenstände in `media_parts` (Transkript-Segmente, OCR je Seite) – nach Neustart
 *   geht es beim nächsten Segment/der nächsten Seite weiter.
 * - Zwei Spuren: "vision" (kurze Bild-/Seitenjobs) und "audio" (lange Transkriptionen), damit ein 3-h-Mitschnitt
 *   keine Fotos blockiert. GPU-Aufrufe gehen über den Scheduler (seriell, Chat und Embedding haben Vorrang).
 * - Abbrechen beendet den Werkzeug-Prozessbaum; Löschen der Quelle entfernt Job, Zwischenstände und Temp-Dateien.
 */
export class MediaService {
  private stopped = true;
  private loops: Promise<void>[] = [];
  private wakers = new Set<() => void>();
  private active = new Map<number, Active>();
  private readonly timeouts: MediaTimeouts;
  private readonly deps: MediaDeps;

  constructor(deps: MediaDeps) {
    this.deps = deps;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    const prev = deps.library.beforeDelete;
    deps.library.beforeDelete = (ids) => {
      prev(ids);
      this.cancelSources(ids);
    };
  }

  get tmpRoot(): string {
    return path.join(this.deps.blobs.tmpDir, 'media');
  }

  tools() {
    return resolveTools(this.deps.toolsDir, this.deps.toolOverrides);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const r = this.deps.db.prepare("UPDATE media_jobs SET state = 'queued' WHERE state = 'running'").run();
    if (Number(r.changes) > 0) this.deps.log(`${r.changes} unterbrochene Medien-Job(s) wieder eingereiht (Fortschritt bleibt erhalten)`);
    this.loops = [this.loop('vision'), this.loop('audio')];
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const a of this.active.values()) a.ctrl.abort();
    for (const w of [...this.wakers]) w();
    await Promise.all(this.loops);
    this.loops = [];
  }

  private wake(): void {
    for (const w of [...this.wakers]) w();
  }

  /* ------------------------------------------------------------ Annahme */

  /**
   * Bild/Audio/Video aus der Import-Queue übernehmen: entweder Medien-Job anlegen (Quelle -> 'media')
   * oder klar begründet nur speichern (Typ ausgeschaltet, Werkzeuge fehlen). Nie ein Absturz.
   */
  handleSource(row: { id: number; kind: string; mime: string }): void {
    const s = this.deps.settings.get();
    const kind = row.kind as MediaJobKind;
    const enabled = kind === 'image' ? s.mediaImages : kind === 'audio' ? s.mediaAudio : kind === 'video' ? s.mediaVideo : false;
    if (!enabled) return this.setSource(row.id, 'unsupported', 'media_disabled', 'processing');
    if (kind === 'audio' || kind === 'video') {
      const t = this.tools();
      if (!t.ffmpeg || !t.whisper || !t.models[s.whisperModel]) return this.setSource(row.id, 'unsupported', 'media_tools_missing', 'processing');
    }
    this.enqueue(row.id, kind, null, 'processing');
  }

  /** Nach der PDF-Extraktion: Seiten ohne Textschicht (und optional eingebettete Bilder) per Vision nachholen. */
  afterPdf(sourceId: number, ocrPages: number[], pages: number | null): void {
    const s = this.deps.settings.get();
    const ocr = s.mediaScanOcr ? ocrPages : [];
    const ocrSet = new Set(ocr);
    const embedded = s.mediaEmbeddedImages && pages ? Array.from({ length: pages }, (_, i) => i + 1).filter((p) => !ocrSet.has(p)).slice(0, MAX_EMBEDDED_PAGES) : [];
    if (!ocr.length && !embedded.length) return;
    this.enqueue(sourceId, 'scan', JSON.stringify({ ocr, embedded }), 'ready');
  }

  private enqueue(sourceId: number, kind: MediaJobKind, params: string | null, expectStatus: string): void {
    const { db } = this.deps;
    const now = Date.now();
    tx(db, () => {
      const st = db.prepare("UPDATE sources SET status = 'media', status_detail = NULL WHERE id = ? AND status = ?").run(sourceId, expectStatus);
      if (!Number(st.changes)) return;
      const old = db.prepare('SELECT id, state, params FROM media_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as
        | { id: number; state: MediaJobState; params: string | null }
        | undefined;
      if (old) {
        // erneuter Versuch nach Fehler/Abbruch: Zwischenstände behalten (setzt fort); nach "fertig"/neuen Parametern: neu
        const fresh = old.state === 'done' || (params !== null && params !== old.params);
        if (fresh) db.prepare('DELETE FROM media_parts WHERE job_id = ?').run(old.id);
        db.prepare(
          `UPDATE media_jobs SET kind = ?, state = 'queued', detail = NULL, params = ?, progress = CASE WHEN ? THEN 0 ELSE progress END, updated_at = ? WHERE id = ?`,
        ).run(kind, fresh ? params : (old.params ?? params), fresh ? 1 : 0, now, old.id);
        db.prepare('DELETE FROM media_jobs WHERE source_id = ? AND id != ?').run(sourceId, old.id);
      } else {
        db.prepare(`INSERT INTO media_jobs(source_id, kind, state, params, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)`).run(sourceId, kind, params, now, now);
      }
    });
    this.emitSource(sourceId);
    this.emitJobs();
    this.wake();
  }

  /** Nach Installation der Werkzeuge bzw. Einschalten eines Typs: "nur gespeicherte" Medien erneut einreihen. */
  requeueStored(details: string[]): number {
    const r = this.deps.db
      .prepare("UPDATE sources SET status = 'queued', status_detail = NULL WHERE status = 'unsupported' AND status_detail IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(details));
    return Number(r.changes);
  }

  /* ------------------------------------------------------------ Steuerung (API) */

  list(limit = 200): MediaJobDTO[] {
    const rows = this.deps.db
      .prepare(
        `SELECT j.id, j.source_id, j.kind, j.state, j.progress, j.total, j.detail, j.params, j.created_at, j.updated_at, s.name AS source_name
         FROM media_jobs j JOIN sources s ON s.id = j.source_id ORDER BY j.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as (JobRow & { source_name: string })[];
    return rows.map((r) => this.dto(r, r.source_name));
  }

  get(id: number): MediaJobDTO | null {
    const r = this.deps.db
      .prepare(
        `SELECT j.id, j.source_id, j.kind, j.state, j.progress, j.total, j.detail, j.params, j.created_at, j.updated_at, s.name AS source_name
         FROM media_jobs j JOIN sources s ON s.id = j.source_id WHERE j.id = ?`,
      )
      .get(id) as (JobRow & { source_name: string }) | undefined;
    return r ? this.dto(r, r.source_name) : null;
  }

  counts(): { queued: number; running: number; error: number } {
    const rows = this.deps.db.prepare("SELECT state, count(*) AS n FROM media_jobs WHERE state IN ('queued', 'running', 'error') GROUP BY state").all() as {
      state: string;
      n: number;
    }[];
    const by = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    return { queued: by('queued'), running: by('running'), error: by('error') };
  }

  private dto(r: JobRow, sourceName: string): MediaJobDTO {
    const a = this.active.get(r.id);
    let etaSec: number | null = null;
    if (a && r.total && r.progress > a.startProgress) {
      const rate = (r.progress - a.startProgress) / ((Date.now() - a.startedAt) / 1000);
      if (rate > 0) etaSec = Math.round((r.total - r.progress) / rate);
    }
    return {
      id: r.id,
      sourceId: r.source_id,
      sourceName,
      kind: r.kind,
      state: r.state,
      progress: r.progress,
      total: r.total,
      detail: r.detail,
      note: a?.note ?? null,
      etaSec,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /** Nutzer bricht ab: laufend -> Prozessbaum beenden; wartend -> sofort "abgebrochen". */
  cancel(id: number): boolean {
    const a = this.active.get(id);
    if (a) {
      a.userCancelled = true;
      a.ctrl.abort();
      return true;
    }
    const row = this.deps.db.prepare("UPDATE media_jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued' RETURNING source_id").get(Date.now(), id) as
      | { source_id: number }
      | undefined;
    if (!row) return false;
    this.setSource(row.source_id, 'cancelled', null, 'media');
    this.emitJobs();
    return true;
  }

  retry(id: number): boolean {
    const row = this.deps.db.prepare("SELECT source_id, kind, params FROM media_jobs WHERE id = ? AND state IN ('error', 'cancelled')").get(id) as
      | { source_id: number; kind: MediaJobKind; params: string | null }
      | undefined;
    if (!row) return false;
    const src = this.deps.db.prepare('SELECT status FROM sources WHERE id = ?').get(row.source_id) as { status: string } | undefined;
    if (!src) return false;
    this.enqueue(row.source_id, row.kind, row.params, src.status);
    return true;
  }

  /** Vor dem Löschen von Quellen: laufende Jobs abbrechen (Zeilen verschwinden per FK-Cascade, Temp-Ordner im finally). */
  cancelSources(ids: number[]): void {
    const set = new Set(ids);
    for (const a of this.active.values()) {
      if (set.has(a.sourceId)) {
        a.userCancelled = true;
        a.ctrl.abort();
      }
    }
  }

  /** Wartet, bis keine Jobs mehr laufen (Tests). */
  get activeCount(): number {
    return this.active.size;
  }

  /* ------------------------------------------------------------ Verarbeitung */

  private claim(lane: 'vision' | 'audio'): JobRow | null {
    const kinds = JSON.stringify(LANES[lane]);
    return (
      (this.deps.db
        .prepare(
          `UPDATE media_jobs SET state = 'running', started_at = ?, updated_at = ?
           WHERE id = (SELECT id FROM media_jobs WHERE state = 'queued' AND kind IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 1)
           RETURNING id, source_id, kind, state, progress, total, detail, params, created_at, updated_at`,
        )
        .get(Date.now(), Date.now(), kinds) as JobRow | undefined) ?? null
    );
  }

  private async loop(lane: 'vision' | 'audio'): Promise<void> {
    while (!this.stopped) {
      const job = this.claim(lane);
      if (!job) {
        await new Promise<void>((resolve) => {
          const w = () => {
            this.wakers.delete(w);
            resolve();
          };
          this.wakers.add(w);
        });
        continue;
      }
      const a: Active = { ctrl: new AbortController(), sourceId: job.source_id, userCancelled: false, startedAt: Date.now(), startProgress: job.progress, note: null, lastEmit: 0 };
      this.active.set(job.id, a);
      this.emitJobs();
      const dir = path.join(this.tmpRoot, `job-${job.id}`);
      try {
        await this.run(job, a, dir);
        this.finishJob(job.id, 'done', null);
      } catch (err) {
        if (this.stopped && !a.userCancelled) {
          // reguläres Beenden: Fortschritt bleibt, Job läuft beim nächsten Start weiter
          this.safe(() => this.deps.db.prepare("UPDATE media_jobs SET state = 'queued', updated_at = ? WHERE id = ?").run(Date.now(), job.id));
        } else if (a.userCancelled || isCancel(err)) {
          this.finishJob(job.id, 'cancelled', null);
          this.setSource(job.source_id, 'cancelled', null, 'media');
        } else {
          const code = (err as { code?: unknown }).code;
          const detail = typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'media_failed';
          this.deps.log(`Medien-Job fehlgeschlagen (${job.kind} #${job.id})`, (err as Error).message);
          this.finishJob(job.id, 'error', detail);
          this.setSource(job.source_id, 'error', detail, 'media');
        }
      } finally {
        this.active.delete(job.id);
        await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        this.emitSource(job.source_id);
        this.emitJobs();
      }
    }
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch {
      /* DB evtl. schon geschlossen */
    }
  }

  private finishJob(id: number, state: MediaJobState, detail: string | null): void {
    this.safe(() => {
      tx(this.deps.db, () => {
        this.deps.db.prepare('UPDATE media_jobs SET state = ?, detail = ?, updated_at = ? WHERE id = ?').run(state, detail, Date.now(), id);
        if (state === 'done') this.deps.db.prepare('DELETE FROM media_parts WHERE job_id = ?').run(id);
        // Verlauf begrenzen
        this.deps.db.prepare("DELETE FROM media_jobs WHERE state = 'done' AND id NOT IN (SELECT id FROM media_jobs WHERE state = 'done' ORDER BY id DESC LIMIT 200)").run();
      });
    });
  }

  private setSource(id: number, status: string, detail: string | null, expect: string): void {
    this.safe(() => this.deps.db.prepare('UPDATE sources SET status = ?, status_detail = ?, processed_at = ? WHERE id = ? AND status = ?').run(status, detail, Date.now(), id, expect));
    this.emitSource(id);
  }

  private emitSource(id: number): void {
    this.safe(() => {
      const s = this.deps.library.getSource(id);
      if (s) this.deps.bus.emit({ type: 'source', source: s });
    });
  }

  private emitJobs(): void {
    this.safe(() => this.deps.bus.emit({ type: 'jobs', counts: this.counts() }));
  }

  private progress(job: JobRow, a: Active, progress: number, total: number | null): void {
    job.progress = progress;
    job.total = total;
    this.deps.db.prepare('UPDATE media_jobs SET progress = ?, total = ?, updated_at = ? WHERE id = ?').run(progress, total, Date.now(), job.id);
    this.emitJob(job, a, true);
  }

  private emitJob(job: JobRow, a: Active, force = false): void {
    const now = Date.now();
    if (!force && now - a.lastEmit < 500) return;
    a.lastEmit = now;
    const dto = this.get(job.id);
    if (dto) this.deps.bus.emit({ type: 'job', job: dto });
  }

  private setNote(job: JobRow, a: Active, note: Active['note']): void {
    if (a.note === note) return;
    a.note = note;
    this.emitJob(job, a, true);
  }

  private source(id: number): SourceRow {
    const s = this.deps.db.prepare('SELECT id, sha256, name, kind, mime, status FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    if (!s) throw codedError('Quelle gelöscht', 'media_cancelled');
    return s;
  }

  private parts(jobId: number): Map<number, unknown> {
    const rows = this.deps.db.prepare('SELECT idx, data FROM media_parts WHERE job_id = ? ORDER BY idx').all(jobId) as { idx: number; data: string }[];
    return new Map(rows.map((r) => [r.idx, JSON.parse(r.data) as unknown]));
  }

  private savePart(job: JobRow, a: Active, idx: number, data: unknown, progress: number, total: number | null): void {
    if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'media_cancelled');
    tx(this.deps.db, () => {
      this.deps.db.prepare('INSERT OR REPLACE INTO media_parts(job_id, idx, data) VALUES (?, ?, ?)').run(job.id, idx, JSON.stringify(data));
      this.progress(job, a, progress, total);
    });
  }

  private async run(job: JobRow, a: Active, dir: string): Promise<void> {
    const src = this.source(job.source_id);
    if (job.kind === 'image') return this.runImage(job, a, src);
    if (job.kind === 'scan') return this.runScan(job, a, src);
    return this.runAudio(job, a, src, dir);
  }

  /** Vision-Aufruf mit GPU-Slot; wartet geduldig, solange Ollama nicht erreichbar ist. */
  private async vision(job: JobRow, a: Active, imageBase64: string, kind: VisionKind): Promise<VisionResult> {
    const { client, scheduler, settings } = this.deps;
    const signal = a.ctrl.signal;
    let backoff = 2000;
    let httpFailures = 0;
    for (;;) {
      const s = settings.get();
      if (scheduler.chatActive) this.setNote(job, a, 'waiting_chat');
      const release = await scheduler.acquire('media', signal);
      try {
        this.setNote(job, a, null);
        const caps = await client.capabilities(s.visionModel).catch((err: unknown) => {
          if (err instanceof OllamaError && err.code === 'model_missing') throw codedError(`Vision-Modell fehlt: ${s.visionModel}`, 'vision_model_missing', err);
          if (err instanceof OllamaError && err.transient) throw err;
          return ['vision']; // ältere Ollama-Versionen ohne capabilities: einfach versuchen
        });
        if (!caps.includes('vision')) throw codedError(`Modell ohne Bildverständnis: ${s.visionModel}`, 'vision_no_capability');
        return await analyzeImage(client, { model: s.visionModel, imageBase64, kind, lang: s.language, numCtx: s.numCtx, signal });
      } catch (err) {
        if (signal.aborted) throw codedError('abgebrochen', 'media_cancelled');
        if (!(err instanceof OllamaError)) throw err;
        if (err.code === 'http' && ++httpFailures >= 3) throw codedError(`Vision-Aufruf fehlgeschlagen: ${err.message}`, 'vision_failed', err);
        if (err.code === 'oom') throw codedError('Zu wenig (Grafik-)Speicher für das Vision-Modell', 'vision_oom', err);
      } finally {
        release();
      }
      this.setNote(job, a, 'waiting_ollama');
      await sleep(backoff, signal);
      backoff = Math.min(60_000, backoff * 2);
    }
  }

  private async storeBlocks(job: JobRow, a: Active, blocks: TextBlock[], warnings: string[] = []): Promise<void> {
    const chunks = chunkBlocks(blocks);
    await this.deps.storeChunks(job.source_id, { chunks, pages: null, warnings }, () => a.ctrl.signal.aborted || this.stopped, 'media');
    if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'media_cancelled');
  }

  private async runImage(job: JobRow, a: Active, src: SourceRow): Promise<void> {
    const file = this.deps.blobs.pathFor(src.sha256);
    const st = await fsp.stat(file);
    if (st.size > MAX_IMAGE_BYTES) throw codedError('Bild zu groß für die Analyse', 'image_too_large');
    const buf = await fsp.readFile(file);
    const size = imageSize(buf);
    if (!size || size.width < 1 || size.height < 1) throw codedError('Bild beschädigt oder unbekannt', 'media_corrupt');
    if (size.width * size.height > MAX_IMAGE_PIXELS || size.width > 30_000 || size.height > 30_000) throw codedError('Bild hat zu viele Pixel', 'image_too_large');
    this.progress(job, a, 0, 1);
    const r = await this.vision(job, a, buf.toString('base64'), 'image');
    this.progress(job, a, 1, 1);
    const blocks: TextBlock[] = [];
    if (r.text) blocks.push({ text: r.text, origin: 'ocr' });
    if (r.description) blocks.push({ text: r.description, origin: 'vision' });
    await this.storeBlocks(job, a, blocks);
  }

  /* ------------------------------------------------------------ Gescannte PDF-Seiten */

  private async runScan(job: JobRow, a: Active, src: SourceRow): Promise<void> {
    const params = JSON.parse(job.params ?? '{}') as { ocr?: number[]; embedded?: number[] };
    const ocr = (params.ocr ?? []).filter((p) => Number.isInteger(p) && p > 0);
    const embedded = (params.embedded ?? []).filter((p) => Number.isInteger(p) && p > 0);
    const total = ocr.length + embedded.length;
    const done = this.parts(job.id);
    const work = [...ocr.map((p) => ({ page: p, idx: p, mode: 'ocr' as const })), ...embedded.map((p) => ({ page: p, idx: EMBEDDED_BASE + p, mode: 'embedded' as const }))];
    let embeddedImages = [...done.entries()].filter(([k]) => k >= EMBEDDED_BASE).reduce((n, [, v]) => n + (v as unknown[]).length, 0);
    this.progress(job, a, done.size, total);
    const pages = new PageImages(this.deps.blobs.pathFor(src.sha256));
    try {
      for (const w of work) {
        if (done.has(w.idx)) continue;
        if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'media_cancelled');
        const results: { text: string; description: string }[] = [];
        if (w.mode === 'ocr' || embeddedImages < MAX_EMBEDDED_IMAGES) {
          const imgs = await pages.get(w.page, w.mode === 'ocr' ? { max: 1, minSide: 200, maxSide: 1600 } : { max: 2, minSide: 200, maxSide: 1280 });
          for (const img of imgs) {
            results.push(await this.vision(job, a, Buffer.from(img.png).toString('base64'), w.mode === 'ocr' ? 'page' : 'image'));
            if (w.mode === 'embedded') embeddedImages++;
          }
        }
        done.set(w.idx, results);
        this.savePart(job, a, w.idx, results, done.size, total);
      }
    } finally {
      await pages.close();
    }
    const drafts: ChunkDraft[] = [];
    let ocrChars = 0;
    for (const w of work) {
      const results = (done.get(w.idx) ?? []) as { text: string; description: string }[];
      const blocks: TextBlock[] = [];
      for (const r of results) {
        if (r.text) blocks.push({ text: r.text, loc: { kind: 'page', index: w.page }, origin: 'ocr' });
        if (w.mode === 'ocr') ocrChars += r.text.length;
        if (r.description && r.description.length >= 20) blocks.push({ text: r.description, loc: { kind: 'page', index: w.page }, origin: 'vision' });
      }
      drafts.push(...chunkBlocks(blocks));
    }
    this.mergePageChunks(job.source_id, drafts, ocr.length > 0 && ocrChars === 0 ? 'ocr_empty' : null);
    if (drafts.length) this.deps.onChunksStored();
  }

  /**
   * OCR-/Bild-Abschnitte seitengenau zwischen die vorhandenen Text-Abschnitte einsortieren (ord neu nummerieren),
   * ohne vorhandene Abschnitte/Vektoren anzufassen. Frühere KI-Abschnitte dieser Quelle werden ersetzt.
   */
  private mergePageChunks(sourceId: number, drafts: ChunkDraft[], detail: string | null): void {
    const { db } = this.deps;
    tx(db, () => {
      if (!db.prepare("SELECT 1 FROM sources WHERE id = ? AND status = 'media'").get(sourceId)) throw codedError('abgebrochen', 'media_cancelled');
      const oldAi = db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ? AND origin IS NOT NULL)').run(sourceId);
      db.prepare('DELETE FROM chunks WHERE source_id = ? AND origin IS NOT NULL').run(sourceId);
      if (Number(oldAi.changes)) this.deps.onChunksReplaced();
      const existing = db.prepare('SELECT id, ord, loc_start AS page FROM chunks WHERE source_id = ? ORDER BY ord').all(sourceId) as { id: number; ord: number; page: number | null }[];
      type Item = { page: number; old?: { id: number; ord: number }; draft?: ChunkDraft; i: number };
      const items: Item[] = [
        ...existing.map((e, i) => ({ page: e.page ?? 0, old: { id: e.id, ord: e.ord }, i })),
        ...drafts.map((d, i) => ({ page: d.locStart ?? 0, draft: d, i })),
      ];
      items.sort((x, y) => x.page - y.page || (x.old ? 0 : 1) - (y.old ? 0 : 1) || x.i - y.i);
      const upd = db.prepare('UPDATE chunks SET ord = ? WHERE id = ?');
      const ins = db.prepare(
        `INSERT INTO chunks(source_id, ord, text, heading, loc_kind, loc_start, loc_end, loc_label, token_est, embed_state, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      items.forEach((it, ord) => {
        if (it.old) {
          if (it.old.ord !== ord) upd.run(ord, it.old.id);
        } else {
          const c = it.draft!;
          ins.run(sourceId, ord, c.text, c.heading, c.locKind, c.locStart, c.locEnd, c.locLabel, c.tokenEst, c.origin ?? null);
        }
      });
      db.prepare("UPDATE sources SET status = 'ready', status_detail = ?, chunk_count = ?, processed_at = ? WHERE id = ?").run(detail, items.length, Date.now(), sourceId);
    });
  }

  /* ------------------------------------------------------------ Audio / Video */

  private async runAudio(job: JobRow, a: Active, src: SourceRow, dir: string): Promise<void> {
    const { settings, db, scheduler } = this.deps;
    const signal = a.ctrl.signal;
    const s = settings.get();
    const tools = this.tools();
    const params = JSON.parse(job.params ?? '{}') as { model?: string; lang?: 'auto' | 'de' | 'en'; duration?: number | null; hasAudio?: boolean; hasVideo?: boolean; probed?: boolean };
    // Fortsetzen mit denselben Parametern wie beim Start (sonst passen die Segmente nicht zusammen)
    params.model ??= s.whisperModel;
    params.lang ??= s.mediaLanguage;
    const model = tools.models[params.model];
    if (!tools.ffmpeg || !tools.whisper || !model) throw codedError('Medien-Werkzeuge fehlen', 'media_tools_missing');
    const file = this.deps.blobs.pathFor(src.sha256);
    if (!params.probed) {
      const p = await probe(tools.ffmpeg, file, { timeouts: this.timeouts, signal });
      Object.assign(params, { duration: p.duration, hasAudio: p.hasAudio, hasVideo: p.hasVideo, probed: true });
      db.prepare('UPDATE media_jobs SET params = ? WHERE id = ?').run(JSON.stringify(params), job.id);
    }
    const maxSec = s.mediaMaxDurationMin * 60;
    const duration = params.duration ?? null;
    if (duration !== null && duration > maxSec) throw codedError('Aufnahme länger als erlaubt', 'media_too_long');
    const keyframes = job.kind === 'video' && s.mediaKeyframes && params.hasVideo;
    if (!params.hasAudio && !keyframes) throw codedError('Keine Tonspur gefunden', 'media_no_audio');
    await fsp.mkdir(dir, { recursive: true });
    const done = this.parts(job.id);
    const threads = Math.max(1, Math.min(8, os.availableParallelism() - 1));

    if (params.hasAudio) {
      let i = 0;
      while (done.has(i)) i++;
      for (;; i++) {
        const win = segmentWindow(i);
        if (duration !== null && i * SEGMENT_SEC >= duration) break;
        if (duration === null && i * SEGMENT_SEC >= maxSec) throw codedError('Aufnahme länger als erlaubt', 'media_too_long');
        if (scheduler.chatActive) this.setNote(job, a, 'waiting_chat');
        await scheduler.whenNoChat(signal);
        this.setNote(job, a, null);
        const wav = path.join(dir, `seg-${i}.wav`);
        const bytes = await extractSegment(tools.ffmpeg, file, wav, win, { timeouts: this.timeouts, signal });
        if (bytes <= 1024) break; // Ende erreicht (Dauer war unbekannt)
        const raw = await transcribeSegment(tools.whisper, model, wav, path.join(dir, `seg-${i}`), {
          language: params.lang,
          threads,
          timeoutMs: Math.max(this.timeouts.whisperMinMs, this.timeouts.whisperPerAudioSecMs * win.length),
          signal,
        });
        const isLast = duration !== null && (i + 1) * SEGMENT_SEC >= duration;
        const entries = keepEntries(parseWhisperJson(raw, win.start), i, isLast);
        const processed = Math.min(duration ?? Infinity, (i + 1) * SEGMENT_SEC);
        this.savePart(job, a, i, entries, processed, duration);
        done.set(i, entries);
        await fsp.rm(wav, { force: true });
        await fsp.rm(path.join(dir, `seg-${i}.json`), { force: true });
      }
    }

    const frames: { t: number; r: VisionResult }[] = [];
    if (keyframes && duration) {
      const count = Math.min(MAX_KEYFRAMES, Math.max(1, Math.floor(duration / 60)));
      for (let k = 0; k < count; k++) {
        const t = Math.floor(((k + 0.5) * duration) / count);
        const prev = done.get(KEYFRAME_BASE + k) as { t: number; r: VisionResult } | null | undefined;
        if (prev !== undefined) {
          if (prev) frames.push(prev);
          continue;
        }
        const jpg = path.join(dir, `frame-${k}.jpg`);
        let rec: { t: number; r: VisionResult } | null = null;
        if (await extractFrame(tools.ffmpeg, file, jpg, t, { timeouts: this.timeouts, signal })) {
          rec = { t, r: await this.vision(job, a, (await fsp.readFile(jpg)).toString('base64'), 'frame') };
          frames.push(rec);
        }
        this.savePart(job, a, KEYFRAME_BASE + k, rec, job.progress, job.total);
        await fsp.rm(jpg, { force: true });
      }
    }

    const blocks: TextBlock[] = [];
    for (const [idx, v] of [...done.entries()].sort((x, y) => x[0] - y[0])) {
      if (idx >= KEYFRAME_BASE) continue;
      for (const e of v as TranscriptEntry[]) blocks.push({ text: e.t, loc: { kind: 'time', index: Math.floor(e.s), end: Math.ceil(e.e) }, origin: 'transcript' });
    }
    for (const f of frames) {
      const text = [f.r.description, f.r.text].filter(Boolean).join('\n\n');
      if (text) blocks.push({ text, loc: { kind: 'time', index: f.t, end: f.t }, origin: 'vision' });
    }
    await this.storeBlocks(job, a, blocks);
  }
}

/** Ein Worker pro Scan-Job; Zeitlimit je Seite, Absturz einer Seite überspringt nur diese Seite. */
class PageImages {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./page-image-worker.ts', import.meta.url), {
        workerData: { path: this.file },
        resourceLimits: { maxOldGenerationSizeMb: 1024 },
      });
      this.worker.unref();
    }
    return this.worker;
  }

  get(page: number, opts: Omit<PageImageRequest, 'id' | 'page'>): Promise<PageImage[]> {
    if (!fs.existsSync(this.file)) return Promise.reject(codedError('Datei fehlt', 'media_cancelled'));
    const w = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const done = (imgs: PageImage[]) => {
        clearTimeout(timer);
        w.off('message', onMsg);
        w.off('error', onErr);
        w.off('exit', onErr);
        resolve(imgs);
      };
      const onMsg = (m: { id: number; ok: boolean; images?: PageImage[] }) => m.id === id && done(m.ok ? (m.images ?? []) : []);
      const onErr = () => {
        this.worker = null;
        done([]);
      };
      const timer = setTimeout(() => {
        void w.terminate();
        onErr();
      }, 120_000);
      w.on('message', onMsg);
      w.on('error', onErr);
      w.on('exit', onErr);
      w.postMessage({ id, page, ...opts } satisfies PageImageRequest);
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}
