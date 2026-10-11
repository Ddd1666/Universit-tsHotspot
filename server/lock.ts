import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Instanz-Sperre im Datenordner: verhindert, dass ein zweiter Start (Desktop + Browser, Doppelklick …)
 * dieselben Daten initialisiert (tmp leeren, Jobs zurücksetzen) und die laufende Instanz beschädigt.
 *
 * „Läuft“ heißt: der Prozess der Sperre lebt UND auf dem eingetragenen Port antwortet ein Uni-Hotspot
 * (`/api/health` ohne Token -> 401 invalid_token). Eine lebende, aber fremde PID (PID-Wiederverwendung,
 * unter Windows häufig) mit totem Port gilt als verwaist und wird übernommen.
 */

export class AlreadyRunningError extends Error {
  readonly pid: number;
  readonly port: number | null;
  /** Pfad der Sperrdatei – darf manuell gelöscht werden, wenn sicher keine Instanz läuft */
  readonly lockFile: string;
  constructor(pid: number, port: number | null, lockFile: string) {
    super(port ? `Uni-Hotspot läuft bereits auf http://127.0.0.1:${port}` : 'Uni-Hotspot läuft bereits (gleicher Datenordner)');
    this.pid = pid;
    this.port = port;
    this.lockFile = lockFile;
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

export interface LockOptions {
  /** prüft, ob auf dem Port ein Uni-Hotspot antwortet (Standard: HTTP-Probe) */
  probe?: (port: number) => Promise<boolean>;
}

/** In diesem Prozess gehaltene Sperren (mehrere Instanzen im selben Prozess, z. B. Tests). */
const held = new Set<string>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parse(raw: string | null): LockInfo | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof p.pid !== 'number') return null;
    return { pid: p.pid, port: typeof p.port === 'number' ? p.port : null, startedAt: p.startedAt ?? 0 };
  } catch {
    return null;
  }
}

function ageMs(file: string): number {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function rmQuiet(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* ignorieren */
  }
}

const tmpName = (file: string) => `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;

/**
 * Legt `file` atomar mit vollständigem Inhalt an – oder gar nicht (false, wenn schon vorhanden).
 * Hardlink auf eine fertig geschriebene Temp-Datei: scheitert mit EEXIST, Leser sehen nie halbe Inhalte.
 */
function createExclusive(file: string, content: string): boolean {
  const tmp = tmpName(file);
  fs.writeFileSync(tmp, content);
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // Dateisystem ohne Hardlinks (FAT/exFAT-Stick, manche Netzlaufwerke): exklusiv anlegen
    try {
      fs.writeFileSync(file, content, { flag: 'wx' });
      return true;
    } catch (err2) {
      if ((err2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err2;
    }
  } finally {
    rmQuiet(tmp);
  }
}

/** Ersetzt den Inhalt atomar (Temp-Datei + rename), mit kurzen Wiederholungen (Windows: Datei kurz geöffnet). */
function replaceAtomic(file: string, content: string): boolean {
  const tmp = tmpName(file);
  for (let i = 0; i < 5; i++) {
    try {
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
      return true;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  rmQuiet(tmp);
  return false;
}

/** Antwortet auf dem Port ein Uni-Hotspot? `/api/health` ohne Token muss 401 invalid_token liefern. */
export function probeHotspot(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        if (body.length < 4096) body += d;
      });
      res.on('end', () => resolve(res.statusCode === 401 && body.includes('invalid_token')));
      res.on('error', () => resolve(false));
    });
    // Verbindung angenommen, aber keine Antwort: im Zweifel als laufend werten (lieber nicht übernehmen)
    req.on('timeout', () => {
      req.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false)); // z. B. ECONNREFUSED: dort läuft nichts
  });
}

async function stillRunning(info: LockInfo, probe: (port: number) => Promise<boolean>): Promise<boolean> {
  if (info.pid === process.pid || !isAlive(info.pid)) return false;
  // Port noch nicht eingetragen (Instanz startet gerade): im Zweifel als laufend werten
  if (info.port === null) return true;
  return probe(info.port);
}

/**
 * Verwaiste Sperre entfernen – aber nur unter einer exklusiven Übernahme-Sperre und nur, wenn sie seit dem
 * Lesen unverändert ist. So können zwei gleichzeitige Starts nach einem Absturz nicht beide übernehmen.
 */
async function removeStale(file: string, staleRaw: string | null): Promise<void> {
  const mutex = file + '.takeover';
  if (!createExclusive(mutex, String(process.pid))) {
    if (ageMs(mutex) > 10_000) rmQuiet(mutex); // Übernahme-Sperre eines abgestürzten Starts
    await sleep(15 + Math.random() * 30);
    return;
  }
  try {
    if (readRaw(file) === staleRaw) rmQuiet(file);
  } finally {
    rmQuiet(mutex);
  }
}

export async function acquireLock(dataDir: string, opts: LockOptions = {}): Promise<InstanceLock> {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'hotspot.lock');
  const key = path.resolve(file);
  if (held.has(key)) throw new AlreadyRunningError(process.pid, parse(readRaw(file))?.port ?? null, file);
  held.add(key);
  const probe = opts.probe ?? probeHotspot;
  const info: LockInfo = { pid: process.pid, port: null, startedAt: Date.now() };
  try {
    let acquired = false;
    for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
      if (createExclusive(file, JSON.stringify(info))) {
        acquired = true;
        break;
      }
      const raw = readRaw(file);
      if (raw === null) continue; // gerade entfernt -> erneut anlegen
      const existing = parse(raw);
      if (!existing && ageMs(file) < 5000) {
        await sleep(20); // wird evtl. gerade geschrieben (Dateisystem ohne Hardlinks)
        continue;
      }
      if (existing && (await stillRunning(existing, probe))) throw new AlreadyRunningError(existing.pid, existing.port, file);
      await removeStale(file, raw);
    }
    if (!acquired) throw new Error(`Sperrdatei ${file} konnte nicht angelegt werden`);
  } catch (err) {
    held.delete(key);
    throw err;
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(key);
    try {
      if (parse(readRaw(file))?.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* ignorieren */
    }
  };
  process.once('exit', release);
  return {
    file,
    setPort(port: number) {
      info.port = port;
      replaceAtomic(file, JSON.stringify(info)); // Port ist für die Erkennung „läuft noch“ nötig
    },
    release() {
      process.removeListener('exit', release);
      release();
    },
  };
}
