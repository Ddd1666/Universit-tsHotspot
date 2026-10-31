import { getMeta, jsonList, setMeta, tx, type DB } from '../db.ts';

export interface VectorHit {
  chunkId: number;
  score: number;
}

export interface VectorIndexInfo {
  /** Embedding-Modell, mit dem der Index gebaut wurde (Query-Embeddings MÜSSEN dasselbe nutzen) */
  model: string | null;
  dim: number | null;
  count: number;
}

/**
 * Vektorspeicher-Schnittstelle. Phase 1 liefert genau eine Implementierung (SQLite-BLOB + Brute-Force-Cosine).
 * LanceDB wurde geprüft und verworfen (Begründung im README: ~1,1 GB node_modules, 340 MB Windows-Binary).
 */
export interface VectorStore {
  readonly kind: string;
  info(): VectorIndexInfo;
  /** Aktiven Index festlegen; anderes Modell/andere Dimension => alle Vektoren verwerfen. */
  setIndex(model: string, dim: number | null): void;
  upsert(items: { chunkId: number; sourceId: number; vector: Float32Array }[]): void;
  /** Cache nach Löschungen (FK-Cascade in SQLite) verwerfen */
  invalidate(): void;
  clear(): void;
  search(query: Float32Array, k: number, allowedSources: Set<number> | null): VectorHit[];
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (!n) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Uint8Array): Float32Array {
  // Kopie, damit die Ausrichtung (4 Byte) garantiert ist
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

interface Cache {
  dim: number;
  count: number;
  chunkIds: Int32Array;
  sourceIds: Int32Array;
  /** quantisiert (int8, Skala je Vektor) oder float32 */
  q8: Int8Array | null;
  scales: Float32Array | null;
  f32: Float32Array | null;
  rowOf: Map<number, number>;
}

/**
 * Exakte Cosine-Suche über alle Vektoren. Vektoren liegen normalisiert als float32-BLOB in SQLite
 * (transaktional mit Chunks, FK-Cascade beim Löschen). Für die Suche wird ein In-Memory-Cache
 * gehalten – standardmäßig int8-quantisiert (¼ RAM; Ranking-Abweichung vernachlässigbar, siehe Tests/Bench).
 */
export class SqliteVectorStore implements VectorStore {
  readonly kind = 'sqlite-bruteforce';
  private cache: Cache | null = null;
  private readonly db: DB;
  private readonly quantize: boolean;
  /** wird aufgerufen, wenn repair() Chunks wieder auf "ausstehend" gesetzt hat */
  onRepaired: (() => void) | null = null;

  constructor(db: DB, opts: { quantize?: boolean } = {}) {
    this.db = db;
    this.quantize = opts.quantize ?? true;
  }

  info(): VectorIndexInfo {
    const model = getMeta(this.db, 'vector_model');
    const dimRaw = getMeta(this.db, 'vector_dim');
    const row = this.db.prepare('SELECT count(*) AS n FROM embeddings').get() as { n: number };
    return { model, dim: dimRaw ? Number(dimRaw) : null, count: row.n };
  }

  setIndex(model: string, dim: number | null): void {
    const cur = this.info();
    if (cur.model === model && (dim === null || cur.dim === dim)) return;
    tx(this.db, () => {
      if (cur.model !== model || (cur.dim !== null && dim !== null && cur.dim !== dim)) {
        this.db.exec('DELETE FROM embeddings');
        this.db.exec('UPDATE chunks SET embed_state = 0');
      }
      setMeta(this.db, 'vector_model', model);
      setMeta(this.db, 'vector_dim', dim === null ? null : String(dim));
    });
    this.invalidate();
  }

  upsert(items: { chunkId: number; sourceId: number; vector: Float32Array }[]): void {
    if (!items.length) return;
    const dim = this.info().dim;
    if (dim !== null && items.some((it) => it.vector.length !== dim)) {
      throw new Error(`Vektordimension passt nicht zum Index (${dim})`);
    }
    const ins = this.db.prepare('INSERT OR REPLACE INTO embeddings(chunk_id, source_id, vec) VALUES (?, ?, ?)');
    const normalized = items.map((it) => ({ ...it, vector: normalize(it.vector) }));
    tx(this.db, () => {
      for (const it of normalized) ins.run(it.chunkId, it.sourceId, toBlob(it.vector));
    });
    if (!this.cache) this.generation++; // laufendes Hintergrund-Laden könnte diese Vektoren verpassen -> abbrechen
    if (this.cache) {
      for (const it of normalized) {
        if (this.cache.rowOf.has(it.chunkId) || it.vector.length !== this.cache.dim) {
          this.cache = null; // selten: Ersetzen -> neu laden
          return;
        }
        this.appendToCache(it.chunkId, it.sourceId, it.vector);
      }
    }
  }

  invalidate(): void {
    this.cache = null;
    this.generation++;
  }

  clear(): void {
    this.db.exec('DELETE FROM embeddings');
    this.invalidate();
  }

  private ensureCapacity(c: Cache, needed: number): void {
    if (c.chunkIds.length >= needed) return;
    const cap = Math.max(needed, Math.ceil(c.chunkIds.length * 1.5), 1024);
    const grow = <T extends Int32Array | Float32Array | Int8Array>(arr: T, size: number, Ctor: new (n: number) => T): T => {
      const next = new Ctor(size);
      next.set(arr);
      return next;
    };
    c.chunkIds = grow(c.chunkIds, cap, Int32Array);
    c.sourceIds = grow(c.sourceIds, cap, Int32Array);
    if (c.q8) c.q8 = grow(c.q8, cap * c.dim, Int8Array);
    if (c.scales) c.scales = grow(c.scales, cap, Float32Array);
    if (c.f32) c.f32 = grow(c.f32, cap * c.dim, Float32Array);
  }

  private appendToCache(chunkId: number, sourceId: number, v: Float32Array, c: Cache = this.cache!): void {
    this.ensureCapacity(c, c.count + 1);
    const row = c.count;
    c.chunkIds[row] = chunkId;
    c.sourceIds[row] = sourceId;
    if (c.q8 && c.scales) {
      let maxAbs = 0;
      for (let i = 0; i < v.length; i++) maxAbs = Math.max(maxAbs, Math.abs(v[i]!));
      const scale = maxAbs / 127 || 1;
      const off = row * c.dim;
      for (let i = 0; i < v.length; i++) c.q8[off + i] = Math.round(v[i]! / scale);
      c.scales[row] = scale;
    } else if (c.f32) {
      c.f32.set(v, row * c.dim);
    }
    c.rowOf.set(chunkId, row);
    c.count++;
  }

  /**
   * Konsistenz: Vektoren, deren Länge nicht zur Index-Dimension (meta) passt, entfernen und die Chunks
   * wieder als "ausstehend" markieren (z. B. nach einem abgebrochenen Modellwechsel). Gibt die Anzahl zurück.
   */
  repair(): number {
    const { dim, count } = this.info();
    if (!count) return 0;
    const bad = (
      dim === null
        ? this.db.prepare('SELECT chunk_id FROM embeddings').all()
        : this.db.prepare('SELECT chunk_id FROM embeddings WHERE length(vec) != ?').all(dim * 4)
    ) as { chunk_id: number }[];
    if (!bad.length) return 0;
    const list = jsonList(bad.map((b) => b.chunk_id));
    tx(this.db, () => {
      this.db.prepare('DELETE FROM embeddings WHERE chunk_id IN (SELECT value FROM json_each(?))').run(list);
      this.db.prepare('UPDATE chunks SET embed_state = 0 WHERE id IN (SELECT value FROM json_each(?))').run(list);
    });
    this.cache = null;
    return bad.length;
  }

  private emptyCache(dim: number, count: number): Cache {
    const c: Cache = {
      dim,
      count: 0,
      chunkIds: new Int32Array(0),
      sourceIds: new Int32Array(0),
      q8: this.quantize ? new Int8Array(0) : null,
      scales: this.quantize ? new Float32Array(0) : null,
      f32: this.quantize ? null : new Float32Array(0),
      rowOf: new Map(),
    };
    this.ensureCapacity(c, count);
    return c;
  }

  private ensureLoaded(): Cache | null {
    if (this.cache) return this.cache;
    if (this.repair() > 0) this.onRepaired?.();
    const info = this.info();
    // Dimension kommt aus den Index-Metadaten, nie aus einer zufälligen ersten Zeile
    if (!info.count || !info.dim) return null;
    const dim = info.dim;
    const c = this.emptyCache(dim, info.count);
    for (const row of this.db.prepare('SELECT chunk_id, source_id, vec FROM embeddings').iterate() as Iterable<{ chunk_id: number; source_id: number; vec: Uint8Array }>) {
      if (row.vec.byteLength !== dim * 4) continue;
      this.appendToCache(row.chunk_id, row.source_id, fromBlob(row.vec), c);
    }
    this.cache = c;
    return c;
  }

  /** Lädt den Cache vorab, synchron (Tests/Bench). */
  warmup(): void {
    this.ensureLoaded();
  }

  /** Erhöht sich bei jeder Änderung, die einen laufenden Hintergrund-Ladevorgang ungültig macht. */
  private generation = 0;
  private loading = false;

  /**
   * Lädt den Cache nach dem Start im Hintergrund in Paketen (Event-Loop bleibt frei; bei 100k Vektoren blockierte das
   * synchrone Laden den Server ~1,8 s am Stück). Ändert sich der Index währenddessen, wird abgebrochen – die nächste Suche
   * lädt dann wie bisher synchron.
   */
  async warmupAsync(batch = 1000): Promise<void> {
    if (this.cache || this.loading) return;
    if (this.repair() > 0) this.onRepaired?.();
    const info = this.info();
    if (!info.count || !info.dim) return;
    const gen = ++this.generation;
    this.loading = true;
    try {
      const c = this.emptyCache(info.dim, info.count);
      const stmt = this.db.prepare('SELECT chunk_id, source_id, vec FROM embeddings WHERE chunk_id > ? ORDER BY chunk_id LIMIT ?');
      let last = 0;
      for (;;) {
        const rows = stmt.all(last, batch) as { chunk_id: number; source_id: number; vec: Uint8Array }[];
        for (const row of rows) if (row.vec.byteLength === info.dim * 4) this.appendToCache(row.chunk_id, row.source_id, fromBlob(row.vec), c);
        if (rows.length < batch) break;
        last = rows[rows.length - 1]!.chunk_id;
        await new Promise((r) => setImmediate(r));
        if (gen !== this.generation || this.cache) return;
      }
      if (gen === this.generation && !this.cache) this.cache = c;
    } finally {
      this.loading = false;
    }
  }

  search(query: Float32Array, k: number, allowedSources: Set<number> | null): VectorHit[] {
    const c = this.ensureLoaded();
    if (!c || query.length !== c.dim) return [];
    const q = normalize(query);
    const dim = c.dim;
    const topIdx: number[] = [];
    const topScore: number[] = [];
    let minScore = -Infinity;
    for (let row = 0; row < c.count; row++) {
      if (allowedSources && !allowedSources.has(c.sourceIds[row]!)) continue;
      let dot = 0;
      const off = row * dim;
      if (c.q8) {
        // 4-fach entrollt mit getrennten Summen: −27 % Rechenzeit bei 100k × 768 (gemessen, scripts/bench-phase4.ts)
        const v = c.q8;
        let a = 0;
        let b = 0;
        let s2 = 0;
        let d = 0;
        let i = 0;
        for (let o = off; i + 3 < dim; i += 4, o += 4) {
          a += v[o]! * q[i]!;
          b += v[o + 1]! * q[i + 1]!;
          s2 += v[o + 2]! * q[i + 2]!;
          d += v[o + 3]! * q[i + 3]!;
        }
        for (; i < dim; i++) a += v[off + i]! * q[i]!;
        dot = (a + b + s2 + d) * c.scales![row]!;
      } else {
        const v = c.f32!;
        for (let i = 0; i < dim; i++) dot += v[off + i]! * q[i]!;
      }
      if (topIdx.length < k || dot > minScore) {
        // Einfügen in sortierte Top-k-Liste (k klein)
        let pos = topScore.length;
        while (pos > 0 && topScore[pos - 1]! < dot) pos--;
        topScore.splice(pos, 0, dot);
        topIdx.splice(pos, 0, row);
        if (topIdx.length > k) {
          topIdx.pop();
          topScore.pop();
        }
        minScore = topIdx.length >= k ? topScore[topScore.length - 1]! : -Infinity;
      }
    }
    return topIdx.map((row, i) => ({ chunkId: c.chunkIds[row]!, score: topScore[i]! }));
  }

  /** RAM des Caches in Bytes (für Bench/Health). */
  memoryBytes(): number {
    const c = this.cache;
    if (!c) return 0;
    return c.chunkIds.byteLength + c.sourceIds.byteLength + (c.q8?.byteLength ?? 0) + (c.scales?.byteLength ?? 0) + (c.f32?.byteLength ?? 0);
  }
}
