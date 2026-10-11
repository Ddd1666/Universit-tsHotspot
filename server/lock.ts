import fs from 'node:fs';
import path from 'node:path';

/**
 * Instanz-Sperre im Datenordner: verhindert, dass ein zweiter Start (Desktop + Browser, Doppelklick …)
 * dieselben Daten initialisiert (tmp leeren, Jobs zurücksetzen) und die laufende Instanz beschädigt.
 */

export class AlreadyRunningError extends Error {
  readonly pid: number;
  readonly port: number | null;
  constructor(pid: number, port: number | null) {
    super(port ? `Uni-Hotspot läuft bereits auf http://127.0.0.1:${port}` : 'Uni-Hotspot läuft bereits (gleicher Datenordner)');
    this.pid = pid;
    this.port = port;
  }
}

interface LockInfo {
  pid: number;
  port: number | null;
  startedAt: number;
}

export interface InstanceLock {
  file: string;
  setPort(port: number): void;
  release(): void;
}

/** In diesem Prozess gehaltene Sperren (mehrere Instanzen im selben Prozess, z. B. Tests). */
const held = new Set<string>();

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number') return null;
    return { pid: parsed.pid, port: typeof parsed.port === 'number' ? parsed.port : null, startedAt: parsed.startedAt ?? 0 };
  } catch {
    return null;
  }
}

export function acquireLock(dataDir: string): InstanceLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'hotspot.lock');
  const key = path.resolve(file);
  if (held.has(key)) {
    throw new AlreadyRunningError(process.pid, readLock(file)?.port ?? null);
  }
  const info: LockInfo = { pid: process.pid, port: null, startedAt: Date.now() };
  try {
    fs.writeFileSync(file, JSON.stringify(info), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const existing = readLock(file);
    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
      throw new AlreadyRunningError(existing.pid, existing.port);
    }
    // verwaist (Absturz) -> übernehmen
    fs.writeFileSync(file, JSON.stringify(info));
  }
  held.add(key);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(key);
    try {
      if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* ignorieren */
    }
  };
  process.once('exit', release);
  return {
    file,
    setPort(port: number) {
      info.port = port;
      try {
        fs.writeFileSync(file, JSON.stringify(info));
      } catch {
        /* Port-Info ist nur ein Hinweis */
      }
    },
    release() {
      process.removeListener('exit', release);
      release();
    },
  };
}
