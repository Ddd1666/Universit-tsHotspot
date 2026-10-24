import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class TooLargeError extends Error {
  readonly code = 'too_large';
  readonly limit: number;
  constructor(limit: number) {
    super(`Datei überschreitet das Limit von ${Math.round(limit / 1024 / 1024)} MB`);
    this.limit = limit;
  }
}

export interface PutResult {
  sha256: string;
  size: number;
  /** true = identischer Inhalt lag bereits im Speicher (Dedupe) */
  existed: boolean;
  /** erste Bytes für Format-Erkennung (Magic Bytes / Text-Sniffing) */
  head: Buffer;
}

const SHA_RE = /^[a-f0-9]{64}$/;
const HEAD_BYTES = 8192;

/** Windows: Virenscanner/Indexer halten frische Dateien kurz offen -> EPERM/EBUSY. Kurz erneut versuchen. */
export async function withFsRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw lastErr;
}

/**
 * Content-addressed Dateispeicher: <data>/files/<aa>/<sha256>.
 * Dateinamen kommen NIE aus Nutzereingaben -> kein Path-Traversal möglich, Dedupe gratis.
 */
export class BlobStore {
  readonly filesDir: string;
  readonly tmpDir: string;

  constructor(dataDir: string) {
    this.filesDir = path.join(dataDir, 'files');
    this.tmpDir = path.join(dataDir, 'tmp');
  }

  /**
   * Ordner anlegen, Reste in tmp/ entfernen. Gesperrte Reste (Virenscanner, noch offene Datei) verhindern den Start
   * NICHT: Rückgabe = Fehlermeldung zum Loggen, sonst null.
   */
  init(): string | null {
    fs.mkdirSync(this.filesDir, { recursive: true });
    let problem: string | null = null;
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      problem = `tmp/ konnte nicht vollständig geleert werden: ${(err as Error).message}`;
    }
    fs.mkdirSync(this.tmpDir, { recursive: true });
    return problem;
  }

  pathFor(sha256: string): string {
    if (!SHA_RE.test(sha256)) throw new Error('ungültiger Hash');
    return path.join(this.filesDir, sha256.slice(0, 2), sha256);
  }

  has(sha256: string): boolean {
    return fs.existsSync(this.pathFor(sha256));
  }

  async putStream(input: Readable, maxBytes: number): Promise<PutResult> {
    const tmp = path.join(this.tmpDir, `${crypto.randomBytes(12).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const headParts: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new TooLargeError(maxBytes));
          return;
        }
        if (headLen < HEAD_BYTES) {
          headParts.push(chunk.subarray(0, HEAD_BYTES - headLen));
          headLen += Math.min(chunk.length, HEAD_BYTES - headLen);
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, fs.createWriteStream(tmp, { flags: 'wx' }));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    const sha256 = hash.digest('hex');
    const finalPath = this.pathFor(sha256);
    let existed = false;
    if (fs.existsSync(finalPath)) {
      existed = true;
      await fsp.rm(tmp, { force: true });
    } else {
      await fsp.mkdir(path.dirname(finalPath), { recursive: true });
      await withFsRetry(() => fsp.rename(tmp, finalPath));
    }
    return { sha256, size, existed, head: Buffer.concat(headParts) };
  }

  /** Alter der Datei (letzte Änderung) in ms; fehlt sie, gilt sie als neu (nicht löschen). */
  ageMs(sha256: string): number {
    try {
      return Date.now() - fs.statSync(this.pathFor(sha256)).mtimeMs;
    } catch {
      return 0;
    }
  }

  async delete(sha256: string): Promise<boolean> {
    try {
      await withFsRetry(() => fsp.rm(this.pathFor(sha256), { force: true }));
      return true;
    } catch {
      return false; // wird beim nächsten Start per GC entfernt
    }
  }

  /** Alle gespeicherten Hashes (für Garbage-Collection verwaister Dateien). */
  listHashes(): string[] {
    const out: string[] = [];
    if (!fs.existsSync(this.filesDir)) return out;
    for (const dir of fs.readdirSync(this.filesDir)) {
      const full = path.join(this.filesDir, dir);
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) if (SHA_RE.test(f)) out.push(f);
    }
    return out;
  }
}
