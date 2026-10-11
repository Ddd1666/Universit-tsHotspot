import type { DB } from './db.ts';

export interface Settings {
  language: 'de' | 'en';
  theme: 'dark' | 'light';
  accent: 'cyan' | 'violet' | 'lime';
  motion: 'system' | 'reduced';
  ollamaUrl: string;
  chatModel: string;
  embeddingModel: string;
  numCtx: number;
  temperature: number;
  thinking: boolean;
  retrievalTopK: number;
  maxFileSizeMB: number;
  zipMaxEntries: number;
  zipMaxTotalMB: number;
  ingestConcurrency: number;
  embedBatchSize: number;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'de',
  theme: 'dark',
  accent: 'cyan',
  motion: 'system',
  ollamaUrl: 'http://127.0.0.1:11434',
  chatModel: 'gemma3:4b',
  embeddingModel: 'nomic-embed-text',
  numCtx: 8192,
  temperature: 0.3,
  thinking: true,
  retrievalTopK: 8,
  maxFileSizeMB: 200,
  zipMaxEntries: 2000,
  zipMaxTotalMB: 1024,
  ingestConcurrency: 1,
  embedBatchSize: 16,
};

type Validator = (v: unknown) => unknown;

const oneOf = (...allowed: string[]): Validator => (v) => {
  if (typeof v !== 'string' || !allowed.includes(v)) throw new Error(`erlaubt: ${allowed.join(', ')}`);
  return v;
};
const int = (min: number, max: number): Validator => (v) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`Ganzzahl ${min}–${max}`);
  return v;
};
const num = (min: number, max: number): Validator => (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`Zahl ${min}–${max}`);
  return v;
};
/** Ollama-Modellnamen wie "gemma3:4b", "hf.co/user/repo:Q4" – ohne "..", führende/abschließende "/" oder Sonderzeichen. */
export function isValidModelName(v: unknown): v is string {
  return typeof v === 'string' && /^[\w.\-/:]{1,200}$/.test(v) && !v.includes('..') && !v.startsWith('/') && !v.endsWith('/') && !v.includes('//');
}

const modelName: Validator = (v) => {
  if (!isValidModelName(v)) throw new Error('ungültiger Modellname');
  return v;
};
const bool: Validator = (v) => {
  if (typeof v !== 'boolean') throw new Error('true/false');
  return v;
};

/** Nur lokale Ollama-Adressen erlaubt: garantiert, dass keine Cloud-/Fremd-Server angesprochen werden. */
export function validateOllamaUrl(v: unknown): string {
  if (typeof v !== 'string') throw new Error('URL erwartet');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error('ungültige URL');
  }
  if (u.protocol !== 'http:') throw new Error('nur http:// (lokal)');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('nur lokale Adressen (127.0.0.1 / localhost) erlaubt');
  }
  if (u.username || u.password) throw new Error('keine Zugangsdaten in der URL');
  return `${u.protocol}//${u.host}`;
}

const VALIDATORS: Record<keyof Settings, Validator> = {
  language: oneOf('de', 'en'),
  theme: oneOf('dark', 'light'),
  accent: oneOf('cyan', 'violet', 'lime'),
  motion: oneOf('system', 'reduced'),
  ollamaUrl: validateOllamaUrl,
  chatModel: modelName,
  embeddingModel: modelName,
  numCtx: int(2048, 131072),
  temperature: num(0, 2),
  thinking: bool,
  retrievalTopK: int(1, 30),
  maxFileSizeMB: int(1, 4096),
  zipMaxEntries: int(1, 100000),
  zipMaxTotalMB: int(1, 16384),
  ingestConcurrency: int(1, 2),
  embedBatchSize: int(1, 128),
};

export class SettingsStore {
  private cache: Settings;
  private listeners = new Set<(s: Settings, changed: (keyof Settings)[]) => void>();
  private readonly db: DB;

  constructor(db: DB) {
    this.db = db;
    this.cache = { ...DEFAULT_SETTINGS };
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    for (const row of rows) {
      if (!Object.hasOwn(VALIDATORS, row.key)) continue;
      const key = row.key as keyof Settings;
      try {
        (this.cache as unknown as Record<string, unknown>)[key] = VALIDATORS[key](JSON.parse(row.value));
      } catch {
        /* ungültigen gespeicherten Wert ignorieren -> Default */
      }
    }
  }

  get(): Settings {
    return { ...this.cache };
  }

  /** Teil-Update mit Validierung; wirft Error mit Feldname bei ungültigen Werten. */
  update(patch: Record<string, unknown>): Settings {
    const next: Record<string, unknown> = { ...this.cache };
    const changed: (keyof Settings)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (!Object.hasOwn(VALIDATORS, k)) throw new Error(`Unbekannte Einstellung: ${k}`);
      const key = k as keyof Settings;
      let value: unknown;
      try {
        value = VALIDATORS[key](v);
      } catch (err) {
        throw new Error(`${k}: ${(err as Error).message}`, { cause: err });
      }
      if (next[key] !== value) {
        next[key] = value;
        changed.push(key);
      }
    }
    const stmt = this.db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const key of changed) stmt.run(key, JSON.stringify(next[key]));
    this.cache = next as unknown as Settings;
    if (changed.length) for (const l of this.listeners) l(this.get(), changed);
    return this.get();
  }

  onChange(fn: (s: Settings, changed: (keyof Settings)[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
