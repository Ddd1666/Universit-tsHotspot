import { jsonList, tx, type DB } from '../db.ts';
import type { EventBus } from '../events.ts';
import type { OllamaClient } from '../ollama/client.ts';
import { OllamaError } from '../ollama/client.ts';
import type { SettingsStore } from '../settings.ts';
import type { VectorStore } from './vector-store.ts';

export type EmbedState = 'idle' | 'running' | 'waiting_ollama' | 'model_missing' | 'error';

export interface EmbedStatus {
  state: EmbedState;
  pending: number;
  done: number;
  failed: number;
  indexModel: string | null;
  indexDim: number | null;
  settingsModel: string;
  reindexNeeded: boolean;
  lastError: string | null;
  retryAt: number | null;
}

/** Modellspezifische Präfixe (nomic-embed-text erwartet Aufgaben-Präfixe). */
export function embedPrefix(model: string, kind: 'document' | 'query'): string {
  if (/nomic-embed/i.test(model)) return kind === 'document' ? 'search_document: ' : 'search_query: ';
  return '';
}

interface PendingRow {
  id: number;
  source_id: number;
  text: string;
  heading: string | null;
  name: string;
}

/**
 * Persistente, neustartfeste Embedding-Queue: "ausstehend" ist ein Zustand in der DB (chunks.embed_state = 0).
 * Fällt Ollama aus, bleibt alles ausstehend und wird mit Backoff automatisch nachgeholt.
 * Volltextsuche funktioniert unabhängig davon.
 */
export class EmbedQueue {
  private stopped = true;
  private wakeFn: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private abort = new AbortController();
  private st: { state: EmbedState; lastError: string | null; retryAt: number | null } = { state: 'idle', lastError: null, retryAt: null };
  private backoffMs = 0;
  private lastEmit = 0;
  private readonly deps: { db: DB; store: VectorStore; client: OllamaClient; settings: SettingsStore; bus: EventBus; onProgress?: () => void };

  constructor(deps: EmbedQueue['deps']) {
    this.deps = deps;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.wakeFn?.();
    await this.loopPromise;
  }

  notify(): void {
    this.backoffMs = 0;
    this.wakeFn?.();
  }

  status(): EmbedStatus {
    const { db, store, settings } = this.deps;
    const counts = db.prepare('SELECT embed_state AS s, count(*) AS n FROM chunks GROUP BY embed_state').all() as { s: number; n: number }[];
    const by = (s: number) => counts.find((c) => c.s === s)?.n ?? 0;
    const info = store.info();
    const settingsModel = settings.get().embeddingModel;
    return {
      ...this.st,
      pending: by(0),
      done: by(1),
      failed: by(2),
      indexModel: info.model,
      indexDim: info.dim,
      settingsModel,
      reindexNeeded: info.model !== null && info.model !== settingsModel,
    };
  }

  /** Index auf das in den Einstellungen gewählte Modell umstellen und alles neu einbetten. */
  reindex(): void {
    const { store, settings, db } = this.deps;
    const model = settings.get().embeddingModel;
    store.setIndex(model, null);
    // gleiches Modell: setIndex ist No-op -> explizit alles neu
    tx(db, () => {
      store.clear();
      db.exec('UPDATE chunks SET embed_state = 0');
    });
    this.st = { state: 'idle', lastError: null, retryAt: null };
    this.notify();
    this.emit(true);
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 400) return;
    this.lastEmit = now;
    this.deps.onProgress?.();
  }

  private setState(state: EmbedState, lastError: string | null = null, retryAt: number | null = null): void {
    const changed = this.st.state !== state || this.st.lastError !== lastError;
    this.st = { state, lastError, retryAt };
    if (changed) this.emit(true);
  }

  private wait(ms: number | null): Promise<void> {
    return new Promise((resolve) => {
      const timer = ms === null ? null : setTimeout(done, ms);
      function done() {
        if (timer) clearTimeout(timer);
        resolve();
      }
      this.wakeFn = () => {
        this.wakeFn = null;
        done();
      };
    });
  }

  private docText(model: string, r: PendingRow): string {
    return `${embedPrefix(model, 'document')}${r.name}${r.heading ? ' – ' + r.heading : ''}\n${r.text}`;
  }

  private store(rows: PendingRow[], vectors: Float32Array[]): void {
    const { db, store } = this.deps;
    tx(db, () => {
      const existing = new Set(
        (db.prepare('SELECT id FROM chunks WHERE id IN (SELECT value FROM json_each(?))').all(jsonList(rows.map((r) => r.id))) as { id: number }[]).map((r) => r.id),
      );
      const items = rows.map((r, i) => ({ chunkId: r.id, sourceId: r.source_id, vector: vectors[i]! })).filter((it) => existing.has(it.chunkId));
      store.upsert(items);
      db.prepare('UPDATE chunks SET embed_state = 1 WHERE id IN (SELECT value FROM json_each(?))').run(jsonList(items.map((i) => i.chunkId)));
    });
  }

  private async loop(): Promise<void> {
    const { db, store, client, settings } = this.deps;
    while (!this.stopped) {
      const s = settings.get();
      if (store.info().model === null) store.setIndex(s.embeddingModel, null);
      const info = store.info();
      const model = info.model!;
      const rows = db
        .prepare(
          `SELECT c.id, c.source_id, c.text, c.heading, s.name FROM chunks c JOIN sources s ON s.id = c.source_id
           WHERE c.embed_state = 0 ORDER BY c.id LIMIT ?`,
        )
        .all(s.embedBatchSize) as unknown as PendingRow[];
      if (!rows.length) {
        this.setState('idle');
        await this.wait(null);
        continue;
      }
      if (this.st.state !== 'running') this.setState('running');
      try {
        const vectors = await client.embed(model, rows.map((r) => this.docText(model, r)), { signal: this.abort.signal });
        const dim = vectors[0]?.length ?? 0;
        if (info.dim === null) store.setIndex(model, dim);
        else if (dim !== info.dim) {
          this.setState('error', `Vektordimension hat sich geändert (${info.dim} -> ${dim}). Bitte Re-Index starten.`);
          await this.wait(null);
          continue;
        }
        this.store(rows, vectors);
        this.backoffMs = 0;
        this.emit();
      } catch (err) {
        if (this.stopped) break;
        const e = err instanceof OllamaError ? err : new OllamaError('http', (err as Error).message);
        if (e.code === 'model_missing') {
          this.setState('model_missing', `Embedding-Modell "${model}" fehlt. Installieren: ollama pull ${model}`, Date.now() + 60_000);
          await this.wait(60_000);
        } else if (e.transient || e.code === 'aborted') {
          this.backoffMs = Math.min(60_000, this.backoffMs ? this.backoffMs * 2 : 2000);
          this.setState('waiting_ollama', e.message, Date.now() + this.backoffMs);
          await this.wait(this.backoffMs);
        } else {
          // dauerhafter Fehler (z. B. HTTP 400): einzeln versuchen, Ausreißer als Fehler markieren
          for (const r of rows) {
            try {
              const [v] = await client.embed(model, [this.docText(model, r)], { signal: this.abort.signal, retries: 0 });
              this.store([r], [v!]);
            } catch (e2) {
              if (e2 instanceof OllamaError && (e2.transient || e2.code === 'aborted')) break;
              db.prepare('UPDATE chunks SET embed_state = 2 WHERE id = ?').run(r.id);
            }
          }
          this.setState('error', e.message);
        }
      }
    }
  }
}
