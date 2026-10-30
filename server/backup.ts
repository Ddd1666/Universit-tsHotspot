import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { APP_VERSION } from './config.ts';
import { MIGRATIONS, SCHEMA_VERSION, type DB } from './db.ts';
import { HttpError } from './library.ts';
import type { SettingsStore } from './settings.ts';

/**
 * Sicherungen (Snapshots) des Datenordners und Wiederherstellung.
 *
 * Snapshot = Ordner `snapshot-<JJJJMMTT-hhmmss>[-n]-<auto|manual|pre-restore>` im Zielordner:
 *   hotspot.sqlite   konsistente Kopie Ã¼ber die SQLite-Backup-API (auch bei laufendem WAL), danach journal_mode=DELETE
 *   files/ab/<sha>   Originaldateien â€“ Hardlink (gleiches Laufwerk; vom vorigen Snapshot oder aus dem Datenordner), sonst Kopie
 *   manifest.json    Format, App-/Schema-Version, Anzahl/GrÃ¶ÃŸe
 * Er entsteht unter `<name>.partial` und wird erst am Ende umbenannt: ein Abbruch (Absturz, kill) hinterlÃ¤sst nie einen
 * halben Snapshot, der als gÃ¼ltig gilt.
 *
 * Wiederherstellen (gefÃ¤hrlicher Pfad): Snapshot wird geprÃ¼ft (Ordner/Dateien ohne Symlinks, DB-Kopf, Schema-Version nicht
 * neuer als die App, quick_check, Schema identisch mit dem, das die Migrationen fÃ¼r diese Version erzeugen), dann wird der
 * Ist-Zustand gesichert, fehlende Originaldateien werden SHA-256-geprÃ¼ft Ã¼bernommen und `restore-pending.json` geschrieben.
 * Der Austausch der DB passiert beim nÃ¤chsten Start (vor dem Ã–ffnen der DB, unter der Instanz-Sperre) â€“ idempotent,
 * ein Abbruch mittendrin wird beim folgenden Start zu Ende gefÃ¼hrt.
 */

export type SnapshotReason = 'auto' | 'manual' | 'pre-restore';
export const SNAPSHOT_RE = /^snapshot-(\d{8}-\d{6})(?:-(\d{1,3}))?-(auto|manual|pre-restore)$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PENDING = 'restore-pending.json';
const REQUIRED_TABLES = ['meta', 'settings', 'subjects', 'sources', 'chunks', 'embeddings', 'chat_sessions', 'chat_messages'];

export interface SnapshotInfo {
  id: string;
  reason: SnapshotReason;
  createdAt: number;
  appVersion: string | null;
  schemaVersion: number | null;
  files: number;
  bytes: number;
  dbBytes: number;
  /** Originaldateien, die beim Sichern fehlten (z. B. gleichzeitig gelÃ¶scht) */
  missing: number;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

/** Pfad muss ein echter Ordner sein (kein Symlink/keine Junction). */
function isRealDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Schema als vergleichbare Liste (Leerraum normalisiert, ANALYZE-Statistik ignoriert). */
function schemaOf(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name").all() as {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }[];
  return rows.map((r) => `${r.type}|${r.name}|${r.tbl_name}|${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`);
}

const referenceSchemas = new Map<number, string[]>();
/** Schema, das die eigenen Migrationen fÃ¼r Version v erzeugen. */
function referenceSchema(v: number): string[] {
  let s = referenceSchemas.get(v);
  if (!s) {
    const mem = new DatabaseSync(':memory:');
    try {
      mem.exec('PRAGMA foreign_keys = ON');
      for (let i = 0; i < v; i++) mem.exec(MIGRATIONS[i]!);
      s = schemaOf(mem);
    } finally {
      mem.close();
    }
    referenceSchemas.set(v, s);
  }
  return s;
}

/**
 * PrÃ¼ft eine fremde/alte DB-Datei, bevor sie die Nutzer-DB ersetzt. Wirft HttpError mit Code.
 * GeÃ¶ffnet wird nur lesend; Trigger/Views werden dabei nicht ausgefÃ¼hrt.
 */
export function inspectDbFile(file: string): { version: number } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new HttpError(404, 'restore_not_found', 'Sicherung nicht gefunden');
  }
  if (!st.isFile()) throw new HttpError(400, 'restore_invalid', 'Datenbank der Sicherung ist keine normale Datei', 'not_a_file');
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\0') throw new HttpError(400, 'restore_invalid', 'Keine SQLite-Datenbank', 'not_sqlite');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new HttpError(400, 'restore_invalid', 'Datenbank nicht lesbar', 'unreadable');
  }
  try {
    db.exec('PRAGMA trusted_schema = OFF');
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) throw new HttpError(409, 'restore_too_new', `Sicherung stammt von einer neueren Version (Schema ${version} > ${SCHEMA_VERSION})`, String(version));
    if (version < 1) throw new HttpError(400, 'restore_invalid', 'Keine Uni-Hotspot-Datenbank', 'no_version');
    const check = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
    if (check !== 'ok') throw new HttpError(400, 'restore_corrupt', 'Datenbank der Sicherung ist beschÃ¤digt');
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (REQUIRED_TABLES.some((t) => !names.has(t))) throw new HttpError(400, 'restore_invalid', 'Keine Uni-Hotspot-Datenbank', 'tables');
    // manipulierte DB (zusÃ¤tzliche Trigger/Views/Spalten) -> verweigern
    const got = schemaOf(db);
    const want = referenceSchema(version);
    if (got.length !== want.length || got.some((x, i) => x !== want[i])) throw new HttpError(400, 'restore_invalid', 'Schema weicht ab (manipulierte oder fremde Datenbank)', 'schema');
    return { version };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'restore_invalid', 'Datenbank nicht lesbar', 'unreadable');
  } finally {
    db.close();
  }
}

/** Alle Originaldateien eines files/-Ordners (strikt: nur aa/<sha>, keine Symlinks). */
function listFiles(filesDir: string): string[] {
  if (!fs.existsSync(filesDir)) return [];
  if (!isRealDir(filesDir)) throw new HttpError(400, 'restore_invalid', 'Dateiordner der Sicherung ist ein Verweis', 'symlink');
  const out: string[] = [];
  for (const d of fs.readdirSync(filesDir, { withFileTypes: true })) {
    if (d.isSymbolicLink()) throw new HttpError(400, 'restore_invalid', 'Verweis (Symlink) in der Sicherung', 'symlink');
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    for (const f of fs.readdirSync(path.join(filesDir, d.name), { withFileTypes: true })) {
      if (f.isSymbolicLink()) throw new HttpError(400, 'restore_invalid', 'Verweis (Symlink) in der Sicherung', 'symlink');
      if (f.isFile() && SHA_RE.test(f.name) && f.name.startsWith(d.name)) out.push(f.name);
    }
  }
  return out;
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Datei per Hardlink (gleiches Laufwerk), sonst als Kopie anlegen. */
async function linkOrCopy(src: string, dest: string): Promise<'link' | 'copy'> {
  try {
    await fsp.link(src, dest);
    return 'link';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'link';
    if (code === 'ENOENT') throw err;
    await fsp.copyFile(src, dest);
    return 'copy';
  }
}

function readManifest(dir: string): Partial<SnapshotInfo> | null {
  try {
    const file = path.join(dir, 'manifest.json');
    if (fs.statSync(file).size > 64 * 1024) return null;
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (m.format !== 'uni-hotspot-snapshot') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return {
      createdAt: num(m.createdAt),
      appVersion: typeof m.appVersion === 'string' ? m.appVersion.slice(0, 40) : null,
      schemaVersion: typeof m.schemaVersion === 'number' ? m.schemaVersion : null,
      files: num(m.files),
      bytes: num(m.bytes),
      dbBytes: num(m.dbBytes),
      missing: num(m.missing),
    };
  } catch {
    return null;
  }
}

/** Sync-Retry fÃ¼r Windows (Virenscanner hÃ¤lt frische Dateien kurz offen). */
function retrySync<T>(fn: () => T): T {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * 2 ** i);
    }
  }
}

export interface PendingRestoreResult {
  ok: boolean;
  id: string | null;
  code?: string;
}

/**
 * Beim Start (Instanz-Sperre gehalten, DB noch nicht geÃ¶ffnet): vorgemerkte Wiederherstellung ausfÃ¼hren.
 * Reihenfolge: Kopie nach `.restore-tmp` -> umbenennen auf hotspot.sqlite -> -wal/-shm der alten DB lÃ¶schen -> Vormerkung lÃ¶schen.
 * Bricht der Prozess irgendwo ab, bleibt die Vormerkung stehen und der nÃ¤chste Start wiederholt alles (die neue DB wird
 * nie mit einem WAL der alten geÃ¶ffnet). `onStep` nur fÃ¼r Tests (Absturz an einer Stelle simulieren).
 */
export function applyPendingRestore(dataDir: string, onStep?: (step: 'copied' | 'renamed' | 'cleaned') => void): PendingRestoreResult | null {
  const pendingFile = path.join(dataDir, PENDING);
  if (!fs.existsSync(pendingFile)) return null;
  let p: { db?: unknown; id?: unknown };
  try {
    p = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as typeof p;
  } catch {
    p = {};
  }
  const id = typeof p.id === 'string' && SNAPSHOT_RE.test(p.id) ? p.id : null;
  const src = typeof p.db === 'string' && path.isAbsolute(p.db) && path.basename(p.db) === 'hotspot.sqlite' ? p.db : null;
  try {
    if (!src || !id) throw new HttpError(400, 'restore_invalid', 'Vormerkung ungÃ¼ltig');
    inspectDbFile(src); // erneut prÃ¼fen: Sicherung kÃ¶nnte seit dem Vormerken verÃ¤ndert worden sein
  } catch (err) {
    fs.rmSync(pendingFile, { force: true });
    return { ok: false, id, code: err instanceof HttpError ? err.code : 'restore_failed' };
  }
  const target = path.join(dataDir, 'hotspot.sqlite');
  const tmp = target + '.restore-tmp';
  retrySync(() => fs.copyFileSync(src, tmp));
  onStep?.('copied');
  retrySync(() => fs.renameSync(tmp, target));
  onStep?.('renamed');
  for (const suffix of ['-wal', '-shm', '-journal']) retrySync(() => fs.rmSync(target + suffix, { force: true }));
  onStep?.('cleaned');
  fs.rmSync(pendingFile, { force: true });
  return { ok: true, id };
}

export class BackupService {
  private running: Promise<unknown> = Promise.resolve();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly deps: { db: DB; dataDir: string; settings: SettingsStore; log: (msg: string, extra?: unknown) => void; onChange?: () => void };
  /** Testhaken: simulierter Absturz/Anhalten wÃ¤hrend des Sicherns */
  onStep: ((step: 'db' | 'files') => void | Promise<void>) | null = null;

  constructor(deps: BackupService['deps']) {
    this.deps = deps;
  }

  /** Zielordner: Einstellung oder <Datenordner>/backups */
  dir(): string {
    const d = this.deps.settings.get().backupDir;
    return d ? path.resolve(d) : path.join(this.deps.dataDir, 'backups');
  }

  get isBusy(): boolean {
    return this.busy;
  }

  list(): SnapshotInfo[] {
    const dir = this.dir();
    if (!isRealDir(dir)) return [];
    const out: SnapshotInfo[] = [];
    for (const name of fs.readdirSync(dir)) {
      const m = SNAPSHOT_RE.exec(name);
      if (!m || !isRealDir(path.join(dir, name))) continue;
      const man = readManifest(path.join(dir, name));
      if (!man) continue;
      out.push({ id: name, reason: m[3] as SnapshotReason, createdAt: man.createdAt ?? 0, appVersion: man.appVersion ?? null, schemaVersion: man.schemaVersion ?? null, files: man.files ?? 0, bytes: man.bytes ?? 0, dbBytes: man.dbBytes ?? 0, missing: man.missing ?? 0 });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }

  /** Pfad eines Snapshots aus seiner ID â€“ nur gÃ¼ltige Namen direkt im Zielordner, kein Symlink. */
  private resolve(id: string): string {
    if (!SNAPSHOT_RE.test(id)) throw new HttpError(400, 'restore_invalid', 'UngÃ¼ltige Sicherungs-ID', 'id');
    const p = path.join(this.dir(), id);
    if (!isRealDir(p)) throw new HttpError(404, 'restore_not_found', 'Sicherung nicht gefunden');
    return p;
  }

  /** Snapshots nacheinander (nie zwei gleichzeitig). */
  create(reason: SnapshotReason): Promise<SnapshotInfo> {
    const run = this.running.then(() => this.doCreate(reason));
    this.running = run.catch(() => {});
    return run;
  }

  private async doCreate(reason: SnapshotReason): Promise<SnapshotInfo> {
    const target = this.dir();
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.accessSync(target, fs.constants.W_OK);
    } catch {
      throw new HttpError(400, 'backup_dir_not_writable', 'Zielordner kann nicht angelegt/beschrieben werden', target);
    }
    if (!isRealDir(target)) throw new HttpError(400, 'backup_dir_not_writable', 'Zielordner ist kein Ordner', target);
    this.busy = true;
    this.deps.onChange?.();
    // Reste abgebrochener LÃ¤ufe (Absturz/kill) entfernen â€“ es lÃ¤uft immer nur ein Snapshot
    for (const name of fs.readdirSync(target)) {
      if (name.endsWith('.partial') && SNAPSHOT_RE.test(name.slice(0, -8))) fs.rmSync(path.join(target, name), { recursive: true, force: true, maxRetries: 3 });
    }
    const prev = this.list()[0] ?? null;
    let id = `snapshot-${stamp()}-${reason}`;
    for (let i = 2; fs.existsSync(path.join(target, id)) || fs.existsSync(path.join(target, id + '.partial')); i++) id = `snapshot-${stamp()}-${i}-${reason}`;
    const tmp = path.join(target, id + '.partial');
    try {
      fs.mkdirSync(tmp);
      const dbFile = path.join(tmp, 'hotspot.sqlite');
      await sqliteBackup(this.deps.db, dbFile, { rate: 256 });
      await this.onStep?.('db');
      // eigenstÃ¤ndige Einzeldatei (kein WAL) + Liste der referenzierten Dateien genau aus dieser Kopie
      const snap = new DatabaseSync(dbFile);
      let hashes: string[];
      let schemaVersion: number;
      try {
        snap.exec('PRAGMA journal_mode = DELETE');
        schemaVersion = (snap.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        hashes = (snap.prepare('SELECT DISTINCT sha256 FROM sources').all() as { sha256: string }[]).map((r) => r.sha256).filter((h) => SHA_RE.test(h));
      } finally {
        snap.close();
      }
      const dataFiles = path.join(this.deps.dataDir, 'files');
      const prevFiles = prev ? path.join(target, prev.id, 'files') : null;
      let files = 0;
      let bytes = 0;
      let missing = 0;
      for (let i = 0; i < hashes.length; i++) {
        const h = hashes[i]!;
        const rel = path.join(h.slice(0, 2), h);
        const dest = path.join(tmp, 'files', rel);
        if (i % 200 === 0) {
          await new Promise((r) => setImmediate(r));
          if (this.stopped) throw new HttpError(503, 'backup_failed', 'Abgebrochen (App wird beendet)');
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        try {
          // inkrementell: gleiche Datei aus dem vorigen Snapshot verlinken (auch wenn der Zielordner auf einem anderen Laufwerk liegt)
          const fromPrev = prevFiles && fs.existsSync(path.join(prevFiles, rel)) ? path.join(prevFiles, rel) : null;
          await linkOrCopy(fromPrev ?? path.join(dataFiles, rel), dest);
          bytes += (await fsp.stat(dest)).size;
          files++;
        } catch {
          missing++; // Originaldatei fehlt (z. B. gerade gelÃ¶scht) â€“ Snapshot bleibt nutzbar
        }
        if (i === Math.floor(hashes.length / 2)) await this.onStep?.('files');
      }
      if (!hashes.length) await this.onStep?.('files');
      const info: SnapshotInfo = { id, reason, createdAt: Date.now(), appVersion: APP_VERSION, schemaVersion, files, bytes, dbBytes: fs.statSync(dbFile).size, missing };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ format: 'uni-hotspot-snapshot', formatVersion: 1, ...info }, null, 2));
      retrySync(() => fs.renameSync(tmp, path.join(target, id)));
      this.deps.log(`Sicherung ${id}: ${files} Datei(en)${missing ? `, ${missing} fehlend` : ''}`);
      this.prune();
      return info;
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
      if (err instanceof HttpError) throw err;
      this.deps.log('Sicherung fehlgeschlagen', { code: (err as NodeJS.ErrnoException).code });
      throw new HttpError(500, 'backup_failed', 'Sicherung fehlgeschlagen', (err as NodeJS.ErrnoException).code);
    } finally {
      this.busy = false;
      this.deps.onChange?.();
    }
  }

  /** Aufbewahrung: nur automatische Snapshots werden ausgedÃ¼nnt (manuelle und "vor Wiederherstellung" bleiben). */
  private prune(): void {
    const keep = this.deps.settings.get().backupKeep;
    for (const s of this.list().filter((x) => x.reason === 'auto').slice(keep)) this.remove(s.id);
  }

  remove(id: string): void {
    const p = this.resolve(id);
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    this.deps.onChange?.();
  }

  /**
   * Wiederherstellung vormerken: prÃ¼fen, Ist-Zustand sichern, fehlende Originaldateien Ã¼bernehmen (Hash geprÃ¼ft),
   * Vormerkung schreiben. Der Austausch der DB passiert beim Neustart (applyPendingRestore).
   */
  async stageRestore(id: string): Promise<{ preRestore: string; missingFiles: number; schemaVersion: number }> {
    const dir = this.resolve(id);
    const dbFile = path.join(dir, 'hotspot.sqlite');
    const { version } = inspectDbFile(dbFile);
    const snapFiles = listFiles(path.join(dir, 'files'));
    const pre = await this.create('pre-restore');
    const dataFiles = path.join(this.deps.dataDir, 'files');
    for (let i = 0; i < snapFiles.length; i++) {
      const h = snapFiles[i]!;
      const rel = path.join(h.slice(0, 2), h);
      const dest = path.join(dataFiles, rel);
      if (fs.existsSync(dest)) continue;
      if (i % 50 === 0) await new Promise((r) => setImmediate(r));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const part = path.join(this.deps.dataDir, 'tmp', `restore-${crypto.randomBytes(6).toString('hex')}.part`);
      await fsp.mkdir(path.dirname(part), { recursive: true });
      await linkOrCopy(path.join(dir, 'files', rel), part);
      // manipulierte Sicherung: Inhalt muss zum Namen (SHA-256) passen, sonst wÃ¼rde der Speicher falsche Inhalte ausliefern
      if ((await sha256File(part)) !== h) {
        await fsp.rm(part, { force: true });
        continue;
      }
      await fsp.rename(part, dest).catch(async () => fsp.rm(part, { force: true }));
    }
    // referenzierte Dateien, die weder in der Sicherung noch im Datenordner liegen
    const ro = new DatabaseSync(dbFile, { readOnly: true });
    let missingFiles = 0;
    try {
      for (const r of ro.prepare('SELECT DISTINCT sha256 FROM sources').all() as { sha256: string }[]) {
        if (!SHA_RE.test(r.sha256) || !fs.existsSync(path.join(dataFiles, r.sha256.slice(0, 2), r.sha256))) missingFiles++;
      }
    } finally {
      ro.close();
    }
    const pendingFile = path.join(this.deps.dataDir, PENDING);
    const tmp = `${pendingFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id, db: dbFile, stagedAt: Date.now() }));
    retrySync(() => fs.renameSync(tmp, pendingFile));
    this.deps.log(`Wiederherstellung von ${id} vorgemerkt (Ist-Zustand gesichert als ${pre.id})`);
    return { preRestore: pre.id, missingFiles, schemaVersion: version };
  }

  /** Automatische Sicherung: prÃ¼ft stÃ¼ndlich (erstmals nach 2 min), ob die letzte automatische Ã¤lter als das Intervall ist. */
  start(): void {
    this.stopped = false;
    const schedule = (ms: number) => {
      this.timer = setTimeout(() => {
        this.autoTick();
        if (!this.stopped) schedule(3_600_000);
      }, ms);
      this.timer.unref();
    };
    schedule(120_000);
  }

  /** FÃ¤llige automatische Sicherung anstoÃŸen (true = gestartet). */
  autoTick(): boolean {
    if (this.stopped || this.busy) return false;
    const hours = this.deps.settings.get().backupIntervalHours;
    if (!hours) return false;
    const last = this.list().find((s) => s.reason === 'auto');
    if (last && Date.now() - last.createdAt < hours * 3_600_000 - 60_000) return false;
    void this.create('auto').catch((err: unknown) => this.deps.log('Automatische Sicherung fehlgeschlagen', { code: (err as HttpError).code }));
    return true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
