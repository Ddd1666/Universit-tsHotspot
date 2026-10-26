import { getMeta, setMeta, tx, type DB } from '../db.ts';
import type { EventBus } from '../events.ts';
import { HttpError, type Library } from '../library.ts';
import type { SettingsStore } from '../settings.ts';
import type { Scheduler } from '../scheduler.ts';
import type { VectorStore } from '../embed/vector-store.ts';
import { normalize } from '../embed/vector-store.ts';
import { embedPrefix } from '../embed/embed-queue.ts';
import { usedCitationNumbers } from '../chat/prompt.ts';
import { estimateTokens } from '../ingest/chunker.ts';
import { codedError } from '../ingest/types.ts';
import { OllamaError, type OllamaClient } from '../ollama/client.ts';
import {
  callValidated,
  CARD_SCHEMA,
  citesIn,
  cardMessages,
  GRAPH_SCHEMA,
  graphMessages,
  isTransient,
  LEVELS,
  mapMessages,
  parseCards,
  parseGraph,
  parseNotes,
  parseQuiz,
  QUIZ_SCHEMA,
  quizMessages,
  reduceMessages,
  renumber,
  type CallOpts,
  type CardDraft,
  type GraphDraft,
  type Level,
  type QuestionDraft,
} from './prompts.ts';
import { documentsBlock, fingerprint, groupChunks, groupKey, loadScope, locOf, refOf, support, type LChunk, type LearnScope, type Ref } from './text.ts';

export type LearnKind = 'summary' | 'cards' | 'quiz' | 'graph';
export type LearnState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface LearnParams {
  scope: LearnScope;
  level?: Level;
  count?: number;
}

export interface LearnJobDTO {
  id: number;
  kind: LearnKind;
  state: LearnState;
  title: string;
  params: LearnParams;
  progress: number;
  total: number | null;
  detail: string | null;
  result: Record<string, number> | null;
  note: 'waiting_ollama' | 'waiting_chat' | 'waiting_media' | null;
  etaSec: number | null;
  createdAt: number;
  updatedAt: number;
}

interface JobRow {
  id: number;
  kind: LearnKind;
  state: LearnState;
  title: string;
  params: string;
  progress: number;
  total: number | null;
  detail: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

interface Active {
  id: number;
  ctrl: AbortController;
  userCancelled: boolean;
  sources: Set<number>;
  note: LearnJobDTO['note'];
  startedAt: number;
  startProgress: number;
  progress: number;
  total: number | null;
  /** einmal pro Job festgehalten: Modell/Kontext/Sprache (Cache-Schlüssel und Aufrufe passen zusammen) */
  cfg: { model: string; numCtx: number; lang: 'de' | 'en' };
}

/** Obergrenzen pro Job (Laufzeit, Speicher, Qualität vor Menge). */
export const LIMITS = {
  summaryChunks: 800,
  cardsChunks: 160,
  quizChunks: 160,
  graphChunks: 600,
  maxCards: 50,
  maxQuestions: 40,
  conceptsPerSource: 60,
  relationsPerSource: 100,
  conceptsPerJob: 400,
  queuedJobs: 50,
};
/** Ab dieser Ähnlichkeit gelten zwei Karten/Fragen/Konzepte als Duplikat. */
export const DUP_SIMILARITY = 0.92;
const LEVEL_PREDICT: Record<Level, number> = { tldr: 400, outline: 1000, detailed: 1500, cheatsheet: 1200 };
/** Antwortlänge je Aufgabe (höchstens ein Viertel von num_ctx – das Text-Budget rechnet mit demselben Wert) */
const TASK_PREDICT = { map: 900, cards: 1500, quiz: 1800, graph: 1200 };
export const predictFor = (base: number, numCtx: number) => Math.min(base, Math.floor(numCtx / 4));
/** nach so vielen Zeitüberschreitungen in Folge bricht ein Job ab (statt endlos "wartet auf Ollama") */
const MAX_TIMEOUTS = 3;
/** Map-Ausgabe gilt als schwach belegt, wenn weniger als dieser Anteil ihrer Inhaltswörter im Abschnitt steht */
const WEAK_SUPPORT = 0.4;
/** so viele Konzepte ohne Vektor werden je Graph-Lauf nachträglich eingebettet */
const VEC_BACKFILL = 500;
/** Abfrageintervall, solange Medien-Jobs Vorrang haben */
const MEDIA_POLL_MS = 1000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(codedError('abgebrochen', 'learn_cancelled'));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i]! * b[i]!;
  return d;
}

export interface LearnDeps {
  db: DB;
  client: OllamaClient;
  settings: SettingsStore;
  scheduler: Scheduler;
  bus: EventBus;
  library: Library;
  vectors: VectorStore;
  log: (msg: string, extra?: unknown) => void;
  /** Tests: Fehler im letzten Schreibschritt einschleusen (Transaktion muss zurückrollen) */
  failBeforeCommit?: (kind: LearnKind) => void;
  /** Zeitlimit je Modellaufruf (Standard 10 min; Tests kürzer) */
  callTimeoutMs?: number;
  /** Medien-Jobs mit Vision-Aufrufen warten/laufen: dann keinen langen Lernaufruf beginnen (würde gleich wieder verdrängt) */
  mediaBusy?: () => boolean;
}

/**
 * Persistente, neustartfeste Lern-Jobs (Zusammenfassung, Karten, Quiz, Graph) – gleiches Muster wie die Medien-Queue:
 * Zustand in `learn_jobs`, Zwischenergebnisse je Textgruppe in `learn_cache` (Schlüssel = Hash von Aufgabe + Text, also
 * automatisch ungültig, wenn sich die Quelle ändert). Nach Neustart/Absturz läuft ein Job weiter und überspringt fertige
 * Schritte. Ergebnis + "fertig" werden in EINER Transaktion geschrieben. Niedrigste Priorität, Chat unterbricht.
 */
export class LearnService {
  private stopped = true;
  private loopPromise: Promise<void> | null = null;
  private waker: (() => void) | null = null;
  private active: Active | null = null;
  private lastEmit = 0;
  private readonly deps: LearnDeps;

  constructor(deps: LearnDeps) {
    this.deps = deps;
    const prev = deps.library.beforeDelete;
    deps.library.beforeDelete = (ids) => {
      prev(ids);
      // Job, der nur aus gelöschten Quellen besteht: abbrechen (ein Fach-Job läuft mit den übrigen weiter)
      const a = this.active;
      if (a && a.sources.size && [...a.sources].every((id) => ids.includes(id))) {
        a.userCancelled = true;
        a.ctrl.abort();
      }
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const r = this.deps.db.prepare("UPDATE learn_jobs SET state = 'queued' WHERE state = 'running'").run();
    if (Number(r.changes) > 0) this.deps.log(`${r.changes} unterbrochene Lern-Job(s) wieder eingereiht`);
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active?.ctrl.abort();
    this.waker?.();
    await this.loopPromise;
  }

  private wake(): void {
    this.waker?.();
  }

  /* ------------------------------------------------------------ API */

  enqueue(kind: LearnKind, params: LearnParams, title: string): LearnJobDTO {
    const { db } = this.deps;
    const queued = (db.prepare("SELECT count(*) AS n FROM learn_jobs WHERE state IN ('queued', 'running')").get() as { n: number }).n;
    if (queued >= LIMITS.queuedJobs) throw new HttpError(429, 'learn_queue_full', 'Zu viele wartende Lern-Aufträge');
    const now = Date.now();
    const id = Number(
      db.prepare("INSERT INTO learn_jobs(kind, state, title, params, created_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?)").run(kind, title.slice(0, 200), JSON.stringify(params), now, now)
        .lastInsertRowid,
    );
    this.emit(id, true);
    this.wake();
    return this.get(id)!;
  }

  list(limit = 100): LearnJobDTO[] {
    return (this.deps.db.prepare('SELECT * FROM learn_jobs ORDER BY id DESC LIMIT ?').all(limit) as unknown as JobRow[]).map((r) => this.dto(r));
  }

  get(id: number): LearnJobDTO | null {
    const r = this.deps.db.prepare('SELECT * FROM learn_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? this.dto(r) : null;
  }

  counts(): { queued: number; running: number; error: number } {
    const rows = this.deps.db.prepare("SELECT state, count(*) AS n FROM learn_jobs WHERE state IN ('queued', 'running', 'error') GROUP BY state").all() as { state: string; n: number }[];
    const by = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    return { queued: by('queued'), running: by('running'), error: by('error') };
  }

  cancel(id: number): boolean {
    if (this.active?.id === id) {
      this.active.userCancelled = true;
      this.active.ctrl.abort();
      return true;
    }
    const r = this.deps.db.prepare("UPDATE learn_jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'").run(Date.now(), id);
    if (!Number(r.changes)) return false;
    this.emit(id, true);
    return true;
  }

  /** Erneut versuchen: fertige Zwischenschritte liegen im Cache und werden übersprungen. */
  retry(id: number): boolean {
    const r = this.deps.db.prepare("UPDATE learn_jobs SET state = 'queued', detail = NULL, progress = 0, updated_at = ? WHERE id = ? AND state IN ('error', 'cancelled')").run(Date.now(), id);
    if (!Number(r.changes)) return false;
    this.emit(id, true);
    this.wake();
    return true;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  private dto(r: JobRow): LearnJobDTO {
    const a = this.active?.id === r.id ? this.active : null;
    let etaSec: number | null = null;
    if (a && a.total && a.progress > a.startProgress) {
      const rate = (a.progress - a.startProgress) / ((Date.now() - a.startedAt) / 1000);
      if (rate > 0) etaSec = Math.round((a.total - a.progress) / rate);
    }
    let params: LearnParams;
    let result: LearnJobDTO['result'] = null;
    try {
      params = JSON.parse(r.params) as LearnParams;
      result = r.result ? (JSON.parse(r.result) as Record<string, number>) : null;
    } catch {
      params = { scope: { kind: 'sources', ids: [] } };
    }
    return {
      id: r.id,
      kind: r.kind,
      state: r.state,
      title: r.title,
      params,
      progress: r.progress,
      total: r.total,
      detail: r.detail,
      result,
      note: a?.note ?? null,
      etaSec,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private emit(id: number, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) return;
    this.lastEmit = now;
    try {
      const job = this.get(id);
      if (job) this.deps.bus.emit({ type: 'learn-job', job });
      this.deps.bus.emit({ type: 'learn-jobs', counts: this.counts() });
    } catch {
      /* DB evtl. geschlossen */
    }
  }

  /* ------------------------------------------------------------ Schleife */

  private claim(): JobRow | null {
    return (
      (this.deps.db
        .prepare(
          `UPDATE learn_jobs SET state = 'running', started_at = ?, updated_at = ?
           WHERE id = (SELECT id FROM learn_jobs WHERE state = 'queued' ORDER BY id LIMIT 1) RETURNING *`,
        )
        .get(Date.now(), Date.now()) as JobRow | undefined) ?? null
    );
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let job: JobRow | null = null;
      try {
        job = this.claim();
      } catch {
        return; // DB geschlossen
      }
      if (!job) {
        await new Promise<void>((resolve) => (this.waker = resolve));
        this.waker = null;
        continue;
      }
      const a: Active = { id: job.id, ctrl: new AbortController(), userCancelled: false, sources: new Set(), note: null, startedAt: Date.now(), startProgress: 0, progress: 0, total: null, cfg: { model: '', numCtx: 8192, lang: 'de' } };
      this.active = a;
      this.emit(job.id, true);
      try {
        const params = JSON.parse(job.params) as LearnParams;
        await this.run(job, params, a);
      } catch (err) {
        const cancelled = a.userCancelled || (err as { code?: string }).code === 'learn_cancelled' || (err as { name?: string }).name === 'AbortError';
        this.safe(() => {
          if (this.stopped && !a.userCancelled) {
            // reguläres Beenden: beim nächsten Start weiter (Zwischenergebnisse liegen im Cache)
            this.deps.db.prepare("UPDATE learn_jobs SET state = 'queued', updated_at = ? WHERE id = ?").run(Date.now(), job.id);
          } else if (cancelled) {
            this.deps.db.prepare("UPDATE learn_jobs SET state = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), job.id);
          } else {
            const code = (err as { code?: unknown }).code;
            // Quelle/Fach/Chat inzwischen gelöscht (Job wartete noch) -> eigener Code statt allgemeinem Fehler
            const detail = code === 'not_found' ? 'learn_scope_missing' : typeof code === 'string' && /^learn_[a-z_]+$/.test(code) ? code : 'learn_failed';
            this.deps.log(`Lern-Job fehlgeschlagen (${job.kind} #${job.id})`, (err as Error).message);
            this.deps.db.prepare("UPDATE learn_jobs SET state = 'error', detail = ?, updated_at = ? WHERE id = ?").run(detail, Date.now(), job.id);
          }
        });
      } finally {
        this.active = null;
        this.emit(job.id, true);
      }
    }
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch {
      /* DB evtl. geschlossen */
    }
  }

  private progress(a: Active, progress: number, total: number | null): void {
    a.progress = progress;
    a.total = total;
    this.deps.db.prepare('UPDATE learn_jobs SET progress = ?, total = ?, updated_at = ? WHERE id = ?').run(progress, total, Date.now(), a.id);
    this.emit(a.id);
  }

  private setNote(a: Active, note: Active['note']): void {
    if (a.note === note) return;
    a.note = note;
    this.emit(a.id, true);
  }

  /** Schreibt das Ergebnis und schließt den Job in DERSELBEN Transaktion ab (Absturz dazwischen: nichts halb). */
  private finish(a: Active, kind: LearnKind, write: () => Record<string, number>): void {
    if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'learn_cancelled');
    tx(this.deps.db, () => {
      const result = write();
      this.deps.failBeforeCommit?.(kind);
      this.deps.db.prepare("UPDATE learn_jobs SET state = 'done', progress = coalesce(total, progress), result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), a.id);
    });
  }

  /* ------------------------------------------------------------ Modellzugriff */

  private async think(model: string): Promise<boolean | undefined> {
    try {
      return (await this.deps.client.capabilities(model)).includes('thinking') ? false : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Ein GPU-Schritt: wartet auf den Slot (Chat > Embedding > Medien > Lernen), bricht ab, sobald ein Chat startet,
   * und wiederholt den Schritt danach. Ollama offline -> geduldig warten (Backoff), wie die Medien-Queue.
   */
  private async llm<T>(a: Active, fn: (o: CallOpts) => Promise<T>): Promise<T> {
    const { scheduler, client } = this.deps;
    let backoff = 2000;
    let httpFailures = 0;
    let timeouts = 0;
    for (;;) {
      // Slot-Übergabe an Medien: zwischen zwei Vision-Aufrufen ist der Slot kurz frei – nicht hineinstarten
      while (this.deps.mediaBusy?.()) {
        this.setNote(a, 'waiting_media');
        await sleep(MEDIA_POLL_MS, a.ctrl.signal);
      }
      if (scheduler.chatActive) this.setNote(a, 'waiting_chat');
      const release = await scheduler.acquire('learn', a.ctrl.signal).catch(() => {
        throw codedError('abgebrochen', 'learn_cancelled');
      });
      const chat = scheduler.chatSignal();
      // höhere Klasse (Embedding/Medien) wartet -> Slot abgeben und Schritt danach wiederholen
      const preempt = scheduler.holderSignal();
      try {
        this.setNote(a, null);
        return await fn({ client, model: a.cfg.model, numCtx: a.cfg.numCtx, think: await this.think(a.cfg.model), signal: AbortSignal.any([a.ctrl.signal, chat, preempt]), timeoutMs: this.deps.callTimeoutMs });
      } catch (err) {
        if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'learn_cancelled');
        if (chat.aborted || preempt.aborted) continue; // Vorrang: Schritt danach wiederholen (fertige liegen im Cache)
        if (err instanceof OllamaError && err.code === 'model_missing') throw codedError(err.message, 'learn_model_missing', err);
        if (err instanceof OllamaError && err.code === 'oom') throw codedError(err.message, 'learn_oom', err);
        if (err instanceof OllamaError && err.code === 'http' && ++httpFailures >= 3) throw codedError(err.message, 'learn_failed', err);
        if (err instanceof OllamaError && err.code === 'timeout') {
          // Ollama erreichbar, aber zu langsam (Modell zu groß für die GPU?) -> nicht endlos warten
          if (++timeouts >= MAX_TIMEOUTS) throw codedError(err.message, 'learn_timeout', err);
          continue;
        }
        if (!isTransient(err) && !(err instanceof OllamaError && err.code === 'http')) throw err;
      } finally {
        release();
      }
      this.setNote(a, 'waiting_ollama');
      await sleep(backoff, a.ctrl.signal);
      backoff = Math.min(60_000, backoff * 2);
    }
  }

  /**
   * Eine Textgruppe verarbeiten. Liefert das Modell auch nach 3 Versuchen keine gültige Ausgabe, wird die Gruppe einmal
   * halbiert (kürzere Eingabe/Ausgabe) und sonst übersprungen – eine kaputte Gruppe kippt nicht den ganzen Job.
   * `stats.failed` zählt nur Gruppen, von denen gar nichts verwertbar war (vergleichbar mit der Gruppenzahl).
   */
  private async tryGroup<T>(g: LChunk[], run: (g: LChunk[]) => Promise<T>, stats: { failed: number }, depth = 0): Promise<{ g: LChunk[]; r: T }[]> {
    try {
      return [{ g, r: await run(g) }];
    } catch (err) {
      if ((err as { code?: string }).code !== 'learn_invalid_output') throw err;
      const mid = Math.ceil(g.length / 2);
      const parts = depth === 0 && g.length > 1 ? [...(await this.tryGroup(g.slice(0, mid), run, stats, 1)), ...(await this.tryGroup(g.slice(mid), run, stats, 1))] : [];
      if (depth === 0 && !parts.length) stats.failed++;
      return parts;
    }
  }

  /** Embeddings für Duplikat-Erkennung; ohne Ollama/Modell -> null (dann nur Text-Fingerabdruck). */
  private async embed(a: Active, texts: string[]): Promise<Float32Array[] | null> {
    if (!texts.length) return [];
    const model = this.deps.vectors.info().model ?? this.deps.settings.get().embeddingModel;
    const release = await this.deps.scheduler.acquire('learn', a.ctrl.signal).catch(() => {
      throw codedError('abgebrochen', 'learn_cancelled');
    });
    try {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const batch = texts.slice(i, i + 64).map((t) => embedPrefix(model, 'document') + t.slice(0, 2000));
        out.push(...(await this.deps.client.embed(model, batch, { signal: a.ctrl.signal, retries: 1, timeoutMs: 60_000 })).map(normalize));
      }
      return out;
    } catch {
      if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'learn_cancelled');
      return null;
    } finally {
      release();
    }
  }

  /** Zwischenergebnis aus dem Cache oder berechnen (nur quellgebundene Gruppen werden gespeichert: Löschen räumt sie per FK ab). */
  private async cached<T>(key: string, sourceId: number | null, compute: () => Promise<T>): Promise<T> {
    const { db } = this.deps;
    const row = db.prepare('SELECT value FROM learn_cache WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as T;
    const value = await compute();
    if (sourceId !== null) {
      db.prepare('INSERT OR REPLACE INTO learn_cache(key, source_id, value, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sources WHERE id = ?)').run(
        key,
        sourceId,
        JSON.stringify(value),
        Date.now(),
        sourceId,
      );
    }
    return value;
  }

  /** Text-Budget pro Aufruf (Token) aus num_ctx: Antwortreserve + System-Prompt abziehen, 10 % Sicherheitsabstand. */
  static docBudget(numCtx: number, predict: number): number {
    return Math.max(300, Math.floor((numCtx - predict - 450) * 0.9));
  }

  /* ------------------------------------------------------------ Ausführung */

  private async run(job: JobRow, params: LearnParams, a: Active): Promise<void> {
    const max = job.kind === 'summary' ? LIMITS.summaryChunks : job.kind === 'graph' ? LIMITS.graphChunks : job.kind === 'cards' ? LIMITS.cardsChunks : LIMITS.quizChunks;
    if (job.kind === 'graph' && params.scope.kind === 'chat') throw codedError('Graph nur aus Quellen', 'learn_invalid_scope');
    const s = this.deps.settings.get();
    a.cfg = { model: s.chatModel, numCtx: s.numCtx, lang: s.language };
    const loaded = loadScope(this.deps.db, params.scope, max);
    if (!loaded.chunks.length) throw codedError('Kein Text im Bereich', 'learn_no_text');
    for (const c of loaded.chunks) if (c.sourceId !== null) a.sources.add(c.sourceId);
    // Kennzahlen der Auswahl (bei zu großem Bereich: gerechte, gleichmäßig verteilte Auswahl – Hinweis in der Oberfläche)
    const scope = { chunks: loaded.chunks.length, total: loaded.total, truncated: loaded.truncated ? 1 : 0 };
    if (job.kind === 'summary') return this.runSummary(a, params, loaded);
    if (job.kind === 'cards') return this.runCards(a, params, loaded.chunks, scope);
    if (job.kind === 'quiz') return this.runQuiz(a, params, loaded.chunks, scope);
    return this.runGraph(a, loaded.chunks, scope);
  }

  private async runSummary(a: Active, params: LearnParams, loaded: ReturnType<typeof loadScope>): Promise<void> {
    const { lang, numCtx, model } = a.cfg;
    const level: Level = LEVELS.includes(params.level as Level) ? params.level! : 'outline';
    const mapPredict = predictFor(TASK_PREDICT.map, numCtx);
    // globale Nummer je Abschnitt (bleibt auch beim Halbieren einer Gruppe erhalten)
    const chunks = loaded.chunks.map((c, i) => ({ ...c, gi: i }));
    const groups = groupChunks(chunks, LearnService.docBudget(numCtx, mapPredict));
    const refs = loaded.chunks.map((c, i) => refOf(c, i + 1));
    const stats = { failed: 0 };
    let weak = 0;
    let done = 0;
    const total = groups.length + 1;
    this.progress(a, 0, total);
    const partials: string[] = [];
    for (const g of groups) {
      const parts = await this.tryGroup(
        g,
        (sub) =>
          this.cached(groupKey('summary-map:v1', sub, [lang, model]), sub[0]!.sourceId, () =>
            this.llm(a, (o) => callValidated(o, mapMessages(documentsBlock(sub), lang), null, mapPredict, (raw) => parseNotes(raw, sub.length))),
          ),
        stats,
      );
      for (const { g: sub, r: local } of parts) {
        // kurze Plausibilitätsprüfung je Stichpunkt: steht die Aussage überhaupt im Abschnitt?
        const srcText = sub.map((c) => c.text).join('\n');
        weak += local.split('\n').filter((l) => /^\s*[-*]/.test(l) && support(l.replace(/\[\d+\]/g, ''), srcText) < WEAK_SUPPORT).length;
        partials.push(renumber(local, (sub[0] as LChunk & { gi: number }).gi));
      }
      this.progress(a, ++done, total);
    }
    if (!partials.length) throw codedError('Modell lieferte für keinen Teil eine gültige Ausgabe', 'learn_invalid_output');
    // Reduce: so lange zusammenführen, bis alles in einen Aufruf passt (Kontext nur num_ctx)
    const predict = Math.min(LEVEL_PREDICT[level], Math.floor(numCtx / 3));
    const budget = LearnService.docBudget(numCtx, predict);
    let notes = partials;
    const cut = () => {
      // Modell kürzt nicht (mehr): hart auf das Budget begrenzen, Notiz bekommt den Hinweis "gekürzt"
      notes = [notes.join('\n').slice(0, budget * 3)];
      loaded.truncated = true;
    };
    // nur Quellnummern behalten, die in der jeweiligen Eingabe vorkamen (das Modell darf keine erfinden)
    const reduce = (text: string, lvl: Level | 'merge') => {
      const input = text.slice(0, budget * 3);
      const allowed = citesIn(input);
      return this.llm(a, (o) => callValidated(o, reduceMessages(input, lvl, lang, loaded.title), null, predict, (raw) => parseNotes(raw, allowed)));
    };
    for (let round = 0; estimateTokens(notes.join('\n')) > budget; round++) {
      const before = estimateTokens(notes.join('\n'));
      if (round >= 6) {
        cut();
        break;
      }
      const batches: string[][] = [[]];
      for (const p of notes) {
        const cur = batches[batches.length - 1]!;
        if (cur.length && estimateTokens([...cur, p].join('\n')) > budget) batches.push([p]);
        else cur.push(p);
      }
      const merged: string[] = [];
      for (const b of batches) {
        const text = b.join('\n');
        merged.push(b.length === 1 && estimateTokens(text) <= budget / 2 ? text : await reduce(text, 'merge'));
      }
      notes = merged;
      if (estimateTokens(notes.join('\n')) >= before) {
        cut();
        break;
      }
    }
    const final = await reduce(notes.join('\n'), level);
    // nur tatsächlich zitierte Quellen, kompakt neu nummeriert (1..k)
    const used = [...usedCitationNumbers(final)].filter((n) => refs[n - 1]).sort((x, y) => x - y);
    const map = new Map(used.map((n, i) => [n, i + 1]));
    const body = final.replace(/\[(\d{1,4})\]/g, (_m, n: string) => (map.has(Number(n)) ? `[${map.get(Number(n))}]` : ''));
    const citations: Ref[] = used.map((n) => ({ ...refs[n - 1]!, n: map.get(n)! }));
    const now = Date.now();
    this.progress(a, total, total);
    this.finish(a, 'summary', () => {
      const noteId = Number(
        this.deps.db
          .prepare('INSERT INTO notes(title, body, level, scope, citations, subject_id, ai, created_at, updated_at) VALUES (?, ?, ?, ?, ?, (SELECT id FROM subjects WHERE id = ?), 1, ?, ?)')
          .run(
            loaded.title,
            body,
            level,
            JSON.stringify({ ...params.scope, truncated: loaded.truncated, chunks: loaded.chunks.length, total: loaded.total, failed: stats.failed, weak }),
            JSON.stringify(citations),
            loaded.subjectId,
            now,
            now,
          ).lastInsertRowid,
      );
      return { noteId, chunks: loaded.chunks.length, total: loaded.total, truncated: loaded.truncated ? 1 : 0, failed: stats.failed, weak };
    });
  }

  /** Kandidaten über Gruppen einsammeln (Cache je Gruppe), bis genug da sind. */
  private async collect<T extends { doc: number }>(
    a: Active,
    chunks: LChunk[],
    task: string,
    want: number,
    predict: number,
    call: (o: CallOpts, docs: string, perGroup: number, g: LChunk[]) => Promise<{ items: T[]; rejected: number }>,
  ): Promise<{ items: (T & { chunk: LChunk })[]; rejected: number; failed: number }> {
    const { lang, numCtx, model } = a.cfg;
    // Auswahl/Fach: Quellen abwechselnd bedienen, innerhalb einer Quelle über das ganze Dokument gestreut
    // (der Lauf stoppt, sobald genug Kandidaten da sind – sonst kämen alle aus Quelle 1 bzw. vom Dokumentanfang)
    const bySource = new Map<number | null, LChunk[][]>();
    for (const g of groupChunks(chunks, Math.min(2500, LearnService.docBudget(numCtx, predict)))) bySource.set(g[0]!.sourceId, [...(bySource.get(g[0]!.sourceId) ?? []), g]);
    const spread = (l: LChunk[][]) => l.map((g, i) => ({ g, k: (i * 0.6180339887) % 1 })).sort((x, y) => x.k - y.k).map((x) => x.g);
    const lanes = [...bySource.values()].map(spread);
    const groups: LChunk[][] = [];
    for (let i = 0; lanes.some((l) => l[i]); i++) for (const l of lanes) if (l[i]) groups.push(l[i]!);
    const perGroup = Math.min(10, Math.max(2, Math.ceil(want / groups.length) + 1));
    const items: (T & { chunk: LChunk })[] = [];
    let rejected = 0;
    const stats = { failed: 0 };
    this.progress(a, 0, groups.length + 1);
    for (let i = 0; i < groups.length && items.length < want * 2; i++) {
      const parts = await this.tryGroup(
        groups[i]!,
        (g) => this.cached(groupKey(task, g, [lang, perGroup, model]), g[0]!.sourceId, () => this.llm(a, (o) => call(o, documentsBlock(g), perGroup, g))),
        stats,
      );
      for (const { g, r } of parts) {
        items.push(...r.items.map((it) => ({ ...it, chunk: g[it.doc - 1]! })));
        rejected += r.rejected;
      }
      this.progress(a, i + 1, groups.length + 1);
    }
    if (stats.failed && !items.length && stats.failed >= groups.length) throw codedError('Modell lieferte für keinen Teil eine gültige Ausgabe', 'learn_invalid_output');
    return { items, rejected, failed: stats.failed };
  }

  /** Duplikate entfernen: gleicher Text-Fingerabdruck oder Embedding-Ähnlichkeit ≥ DUP_SIMILARITY (auch gegen Bestand). */
  private async dedupe<T>(a: Active, items: T[], text: (t: T) => string, existing: string[], max: number): Promise<{ kept: T[]; duplicates: number }> {
    const seen = new Set(existing.map(fingerprint));
    const unique = items.filter((it) => {
      const f = fingerprint(text(it));
      if (seen.has(f)) return false;
      seen.add(f);
      return true;
    });
    const vecs = await this.embed(a, [...unique.map(text), ...existing.slice(0, 500)]);
    const kept: T[] = [];
    if (!vecs) kept.push(...unique.slice(0, max));
    else {
      const old = vecs.slice(unique.length);
      const chosen: Float32Array[] = [];
      unique.forEach((it, i) => {
        const v = vecs[i]!;
        if (kept.length >= max || [...old, ...chosen].some((o) => o.length === v.length && cosine(o, v) >= DUP_SIMILARITY)) return;
        chosen.push(v);
        kept.push(it);
      });
    }
    return { kept, duplicates: items.length - kept.length };
  }

  private sourceMeta(sourceId: number | null): { subjectId: number | null; kind: string | null } {
    if (sourceId === null) return { subjectId: null, kind: null };
    const r = this.deps.db.prepare('SELECT subject_id AS subjectId, kind FROM sources WHERE id = ?').get(sourceId) as { subjectId: number | null; kind: string } | undefined;
    return r ?? { subjectId: null, kind: null };
  }

  private async runCards(a: Active, params: LearnParams, chunks: LChunk[], scope: Record<string, number>): Promise<void> {
    const max = Math.min(LIMITS.maxCards, Math.max(1, params.count ?? 20));
    const predict = predictFor(TASK_PREDICT.cards, a.cfg.numCtx);
    const { items, rejected, failed } = await this.collect<CardDraft>(a, chunks, 'cards:v1', max, predict, async (o, docs, n, g) => {
      const r = await callValidated(o, cardMessages(docs, n, a.cfg.lang), CARD_SCHEMA, predict, (raw) => parseCards(raw, g, n));
      return { items: r.cards, rejected: r.rejected };
    });
    const srcIds = [...a.sources];
    const existing = (this.deps.db.prepare('SELECT front, back FROM cards WHERE source_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 2000').all(JSON.stringify(srcIds)) as {
      front: string;
      back: string;
    }[]).map((c) => `${c.front}\n${c.back}`);
    const { kept, duplicates } = await this.dedupe(a, items, (c) => `${c.front}\n${c.back}`, existing, max);
    const now = Date.now();
    this.finish(a, 'cards', () => {
      const ins = this.deps.db.prepare(
        `INSERT INTO cards(type, front, back, status, ai, subject_id, source_id, chunk_id, source_name, loc, job_id, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', 1, ?, (SELECT id FROM sources WHERE id = ?), (SELECT id FROM chunks WHERE id = ?), ?, ?, ?, ?, ?)`,
      );
      for (const c of kept) {
        const meta = this.sourceMeta(c.chunk.sourceId);
        // Frage/Antwort aus einem Bild -> Bildkarte; Lückentext bleibt Lückentext (das Bild zeigt die Karte zusätzlich)
        const type = meta.kind === 'image' && c.type === 'qa' ? 'image' : c.type;
        ins.run(type, c.front, c.back, meta.subjectId, c.chunk.sourceId, c.chunk.id, c.chunk.sourceId !== null ? c.chunk.sourceName : null, JSON.stringify(c.chunk.chatId ? { chat: c.chunk.chatId, t: c.chunk.sourceName } : locOf(c.chunk)), a.id, now, now);
      }
      return { created: kept.length, rejected, duplicates, failed, ...scope };
    });
  }

  private async runQuiz(a: Active, params: LearnParams, chunks: LChunk[], scope: Record<string, number>): Promise<void> {
    const max = Math.min(LIMITS.maxQuestions, Math.max(1, params.count ?? 12));
    const predict = predictFor(TASK_PREDICT.quiz, a.cfg.numCtx);
    const { items, rejected, failed } = await this.collect<QuestionDraft>(a, chunks, 'quiz:v1', max, predict, async (o, docs, n, g) => {
      const r = await callValidated(o, quizMessages(docs, n, a.cfg.lang), QUIZ_SCHEMA, predict, (raw) => parseQuiz(raw, g, n));
      return { items: r.questions, rejected: r.rejected };
    });
    const existing = (this.deps.db.prepare('SELECT question FROM quiz_questions WHERE source_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 2000').all(JSON.stringify([...a.sources])) as {
      question: string;
    }[]).map((q) => q.question);
    const { kept, duplicates } = await this.dedupe(a, items, (q) => q.question, existing, max);
    const now = Date.now();
    this.finish(a, 'quiz', () => {
      let created = 0;
      const ins = this.deps.db.prepare(
        `INSERT OR IGNORE INTO quiz_questions(type, question, options, answer, explanation, topic, fingerprint, subject_id, source_id, chunk_id, source_name, loc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM sources WHERE id = ?), (SELECT id FROM chunks WHERE id = ?), ?, ?, ?)`,
      );
      for (const q of kept) {
        const meta = this.sourceMeta(q.chunk.sourceId);
        created += Number(
          ins.run(q.type, q.question, q.options ? JSON.stringify(q.options) : null, q.answer, q.explanation, (q.chunk.heading ?? q.chunk.sourceName).slice(0, 200), fingerprint(q.question), meta.subjectId, q.chunk.sourceId, q.chunk.id, q.chunk.sourceId !== null ? q.chunk.sourceName : null, JSON.stringify(q.chunk.chatId ? { chat: q.chunk.chatId, t: q.chunk.sourceName } : locOf(q.chunk)), now).changes,
        );
      }
      return { created, rejected, duplicates: duplicates + kept.length - created, failed, ...scope };
    });
  }

  /* ------------------------------------------------------------ Wissensgraph */

  private async runGraph(a: Active, chunks: LChunk[], scope: Record<string, number>): Promise<void> {
    const { db } = this.deps;
    const { lang, numCtx, model } = a.cfg;
    const predict = predictFor(TASK_PREDICT.graph, numCtx);
    // Konzept-Vektoren gehören zu einem Embedding-Modell: nach einem Modellwechsel nicht mehr vergleichbar -> verwerfen
    const embedModel = this.deps.vectors.info().model ?? this.deps.settings.get().embeddingModel;
    const vecModel = getMeta(db, 'concept_vec_model');
    if (vecModel === null) setMeta(db, 'concept_vec_model', embedModel); // erster Lauf: vorhandene Vektoren stammen vom aktuellen Modell
    else if (vecModel !== embedModel) {
      tx(db, () => {
        db.exec('UPDATE concepts SET vec = NULL');
        setMeta(db, 'concept_vec_model', embedModel);
      });
    }
    // Konzepte ohne Vektor (nach Modellwechsel oder Embedding damals nicht verfügbar) mit dem aktuellen Modell nachtragen
    // ponytail: höchstens VEC_BACKFILL je Lauf, der Rest folgt bei den nächsten Läufen
    const missing = db.prepare('SELECT id, name FROM concepts WHERE vec IS NULL ORDER BY id LIMIT ?').all(VEC_BACKFILL) as { id: number; name: string }[];
    const filled = await this.embed(a, missing.map((m) => m.name));
    if (filled?.length) {
      tx(db, () => {
        const up = db.prepare('UPDATE concepts SET vec = ? WHERE id = ?');
        missing.forEach((m, i) => up.run(new Uint8Array(filled[i]!.buffer, filled[i]!.byteOffset, filled[i]!.byteLength), m.id));
      });
    }
    const stats = { failed: 0 };
    const bySource = new Map<number, LChunk[]>();
    for (const c of chunks) bySource.set(c.sourceId!, [...(bySource.get(c.sourceId!) ?? []), c]);
    const plan = [...bySource.entries()].map(([id, cs]) => ({ id, groups: groupChunks(cs, LearnService.docBudget(numCtx, predict)) }));
    const total = plan.reduce((n, p) => n + p.groups.length, 0);
    let done = 0;
    let concepts = 0;
    let relations = 0;
    this.progress(a, 0, total);
    const known = this.conceptVectors();
    for (const p of plan) {
      const drafts: (GraphDraft & { group: LChunk[] })[] = [];
      for (const group of p.groups) {
        const parts = await this.tryGroup(
          group,
          (g) => this.cached(groupKey('graph:v1', g, [lang, model]), p.id, () => this.llm(a, (o) => callValidated(o, graphMessages(documentsBlock(g), lang), GRAPH_SCHEMA, predict, (raw) => parseGraph(raw, g)))),
          stats,
        );
        for (const { g, r } of parts) drafts.push({ ...r, group: g });
        this.progress(a, ++done, total);
      }
      // Konzepte der Quelle zusammenführen (gleicher normalisierter Name), begrenzen
      const merged = new Map<string, { name: string; description: string; chunkId: number | null }>();
      for (const d of drafts) for (const c of d.concepts) if (!merged.has(c.norm) && merged.size < LIMITS.conceptsPerSource) merged.set(c.norm, { name: c.name, description: c.description, chunkId: d.group[c.doc - 1]?.id ?? null });
      const rels = new Map<string, { from: string; to: string; label: string }>();
      for (const d of drafts) for (const r of d.relations) if (merged.has(r.from) && merged.has(r.to) && rels.size < LIMITS.relationsPerSource) rels.set([r.from, r.to].sort().join('\u0000'), r);
      // neue Namen: Embedding-Ähnlichkeit gegen den Bestand (z. B. "2. Hauptsatz" ≈ "Zweiter Hauptsatz")
      const fresh = [...merged.keys()].filter((n) => !db.prepare('SELECT 1 FROM concepts WHERE norm = ?').get(n));
      const vecs = await this.embed(a, fresh.map((n) => merged.get(n)!.name));
      const vecOf = new Map(fresh.map((n, i) => [n, vecs?.[i] ?? null]));
      // Ähnlichkeitssuche VOR der Transaktion und in Häppchen (Event-Loop: Konzepte × Bestand × Dimension wächst mit der Bibliothek)
      const bestOf = new Map<string, number>();
      for (const [i, norm] of fresh.entries()) {
        const v = vecOf.get(norm);
        if (!v) continue;
        let best: { id: number; sim: number } | null = null;
        for (const k of known) if (k.vec.length === v.length) {
          const sim = cosine(k.vec, v);
          if (sim >= DUP_SIMILARITY && (!best || sim > best.sim)) best = { id: k.id, sim };
        }
        if (best) bestOf.set(norm, best.id);
        if (i % 8 === 7) await new Promise<void>((r) => setImmediate(r));
      }
      if (a.ctrl.signal.aborted) throw codedError('abgebrochen', 'learn_cancelled');
      tx(db, () => {
        if (!db.prepare('SELECT 1 FROM sources WHERE id = ?').get(p.id)) return; // inzwischen gelöscht
        const idOf = new Map<string, number>();
        const now = Date.now();
        for (const [norm, c] of merged) {
          let id = (db.prepare('SELECT id FROM concepts WHERE norm = ?').get(norm) as { id: number } | undefined)?.id;
          const v = vecOf.get(norm) ?? null;
          const similar = bestOf.get(norm);
          // Konzept kann inzwischen verwaist und gelöscht sein (Trigger) -> nicht mehr als Ziel verwenden
          if (!id && similar && db.prepare('SELECT 1 FROM concepts WHERE id = ?').get(similar)) id = similar;
          if (!id) {
            if (concepts >= LIMITS.conceptsPerJob) continue;
            id = Number(
              db.prepare('INSERT INTO concepts(name, norm, description, vec, created_at) VALUES (?, ?, ?, ?, ?)').run(c.name, norm, c.description || null, v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null, now)
                .lastInsertRowid,
            );
            if (v) known.push({ id, vec: v });
            concepts++;
          }
          idOf.set(norm, id);
          db.prepare('INSERT INTO concept_sources(concept_id, source_id, chunk_id) VALUES (?, ?, (SELECT id FROM chunks WHERE id = ?)) ON CONFLICT DO UPDATE SET chunk_id = excluded.chunk_id').run(id, p.id, c.chunkId);
        }
        const keepEdges: number[] = [];
        for (const r of rels.values()) {
          const x = idOf.get(r.from);
          const y = idOf.get(r.to);
          if (!x || !y || x === y) continue;
          const [ea, eb] = x < y ? [x, y] : [y, x];
          const row = db
            // vom Nutzer umbenannte Kanten (edited = 1) behalten ihre Bezeichnung
            .prepare('INSERT INTO concept_edges(a, b, label, source_id) VALUES (?, ?, ?, ?) ON CONFLICT(a, b, source_id) DO UPDATE SET label = CASE WHEN edited THEN label ELSE excluded.label END RETURNING id')
            .get(ea, eb, r.label, p.id) as { id: number };
          keepEdges.push(row.id);
          relations++;
        }
        // Veraltete Bezüge dieser Quelle entfernen (Nutzer-Korrekturen an weiter vorhandenen Konzepten/Kanten bleiben)
        db.prepare('DELETE FROM concept_edges WHERE source_id = ? AND edited = 0 AND id NOT IN (SELECT value FROM json_each(?))').run(p.id, JSON.stringify(keepEdges));
        db.prepare('DELETE FROM concept_sources WHERE source_id = ? AND concept_id NOT IN (SELECT value FROM json_each(?))').run(p.id, JSON.stringify([...idOf.values()]));
      });
      await new Promise<void>((r) => setImmediate(r));
    }
    if (stats.failed && stats.failed >= total && !concepts && !relations) throw codedError('Modell lieferte für keinen Teil eine gültige Ausgabe', 'learn_invalid_output');
    this.finish(a, 'graph', () => ({ concepts, relations, sources: plan.length, failed: stats.failed, ...scope }));
  }

  private conceptVectors(): { id: number; vec: Float32Array }[] {
    const rows = this.deps.db.prepare('SELECT id, vec FROM concepts WHERE vec IS NOT NULL').all() as { id: number; vec: Uint8Array }[];
    return rows.map((r) => {
      const copy = new Uint8Array(r.vec.byteLength);
      copy.set(r.vec);
      return { id: r.id, vec: new Float32Array(copy.buffer) };
    });
  }
}
