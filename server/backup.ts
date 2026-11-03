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
 *   hotspot.sqlite   konsistente Kopie über die SQLite-Backup-API (auch bei laufendem WAL), danach journal_mode=DELETE
 *   files/ab/<sha>   Originaldateien – Hardlink (gleiches Laufwerk; vom vorigen Snapshot oder aus dem Datenordner), sonst Kopie
 *   manifest.json    Format, App-/Schema-Version, Anzahl/Größe
 * Er entsteht unter `<name>.partial` und wird erst am Ende umbenannt: ein Abbruch (Absturz, kill) hinterlässt nie einen
 * halben Snapshot, der als gültig gilt.
 *
 * Wiederherstellen (gefährlicher Pfad): Snapshot wird geprüft (Ordner/Dateien ohne Symlinks, DB-Kopf, Schema-Version nicht
 * neuer als die App, quick_check, Schema identisch mit dem, das die Migrationen für diese Version erzeugen), dann wird der
 * Ist-Zustand gesichert, fehlende Originaldateien werden SHA-256-geprüft übernommen und `restore-pending.json` geschrieben.
 * Der Austausch der DB passiert beim nächsten Start (vor dem Öffnen der DB, unter der Instanz-Sperre) – idempotent,
 * ein Abbruch mittendrin wird beim folgenden Start zu Ende geführt.
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
  /** Originaldateien, die beim Sichern fehlten (z. B. gleichzeitig gelöscht) */
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
/** Schema, das die eigenen Migrationen für Version v erzeugen. */
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
 * Prüft eine fremde/alte DB-Datei, bevor sie die Nutzer-DB ersetzt. Wirft HttpError mit Code.
 * Geöffnet wird nur lesend; Trigger/Views werden dabei nicht ausgeführt.
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
    if (check !== 'ok') throw new HttpError(400, 'restore_corrupt', 'Datenbank der Sicherung ist beschädigt');
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (REQUIRED_TABLES.some((t) => !names.has(t))) throw new HttpError(400, 'restore_invalid', 'Keine Uni-Hotspot-Datenbank', 'tables');
    // manipulierte DB (zusätzliche Trigger/Views/Spalten) -> verweigern
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

/** Löschen, das nie wirft (Windows: Virenscanner/Explorer hält Dateien offen) – Fehler nur loggen. */
function rmLogged(p: string, log: (msg: string, extra?: unknown) => void): boolean {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch (err) {
    log('Löschen fehlgeschlagen (wird später erneut versucht)', { code: (err as NodeJS.ErrnoException).code });
    return false;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** Längster Pfad unterhalb des Zielordners: \snapshot-JJJJMMTT-hhmmss-999-pre-restore.partial\files\ab\<sha256> (123 Zeichen) */
const LONGEST_REL = '\\snapshot-20261030-120000-999-pre-restore.partial\\files\\ab\\'.length + 64;
/** Zielordner + längster Pfad darin < 240 (Reserve zum Windows-Limit 260) -> Zielordner höchstens 117 Zeichen */
export const BACKUP_DIR_MAX = 240 - LONGEST_REL;

/**
 * Zielordner prüfen (null = ok, sonst Grund): absolut, nicht zu lang (s. BACKUP_DIR_MAX), kein UNC-/Gerätepfad
 * (\\server\share, \\localhost\c$, \\?\…), keine reservierten Namen (CON, NUL, COM1 …) und nicht in <Datenordner>/files
 * bzw. /tmp (würde beim Aufräumen/als Originaldatei behandelt). Der Vergleich läuft nach dem Anlegen über den echten Pfad
 * (realpath): Junctions, 8.3-Kurznamen, Punkt/Leerzeichen am Ende, subst-Laufwerke. Unter Windows ohne Groß/Klein.
 */
export function backupDirProblem(dir: string, dataDir: string): string | null {
  const raw = dir.trim();
  if (!raw) return null;
  if (!path.isAbsolute(raw)) return 'not_absolute';
  if (/^[\\/]{2}/.test(raw)) return 'unc';
  if (raw.length > BACKUP_DIR_MAX) return 'too_long';
  if (raw.split(/[\\/]/).some((seg) => RESERVED.test(seg.trim()))) return 'reserved_name';
  const win = process.platform === 'win32';
  // Punkt/Leerzeichen am Ende: Node legt "files." über \\?\ als eigenen Ordner an, Explorer & Co. kürzen es zu "files"
  if (win && path.resolve(raw).split(path.sep).some((seg) => /[. ]$/.test(seg) && seg !== '.' && seg !== '..')) return 'reserved_name';
  const inside = (d: string, s: string) => d === s || d.startsWith(s + path.sep);
  const norm = (p: string) => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return win ? r.toLowerCase() : r;
  };
  const subs = ['files', 'tmp'].map((sub) => path.join(dataDir, sub));
  if (subs.some((s) => inside(norm(raw), norm(s)))) return 'inside_data';
  let created: string | undefined;
  try {
    created = fs.mkdirSync(raw, { recursive: true });
  } catch {
    return null; // (noch) nicht anlegbar, z. B. Stick nicht eingesteckt: doCreate prüft beim Sichern erneut
  }
  try {
    const real = (p: string) => (win ? fs.realpathSync.native(p).toLowerCase() : fs.realpathSync.native(p));
    const d = real(raw);
    if (subs.some((s) => fs.existsSync(s) && inside(d, real(s)))) {
      if (created) fs.rmSync(created, { recursive: true, force: true }); // nur eben angelegte (leere) Ordner wieder weg
      return 'inside_data';
    }
  } catch {
    /* realpath nicht ermittelbar: Zeichenkettenprüfung oben gilt */
  }
  return null;
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
    const st = fs.statSync(file);
    if (st.size > 64 * 1024) return null;
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (m.format !== 'uni-hotspot-snapshot') return null;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const now = Date.now();
    // manipulierte/verstellte Uhr: ein Zeitpunkt in der Zukunft würde die Automatik dauerhaft blockieren -> Dateizeit, sonst 0
    const created = num(m.createdAt) > now + 60_000 ? (st.mtimeMs <= now + 60_000 ? st.mtimeMs : 0) : num(m.createdAt);
    return {
      createdAt: created,
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

/** Sync-Retry für Windows (Virenscanner hält frische Dateien kurz offen). */
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
  /** Sicherungs-Einstellungen vor der Wiederherstellung – werden nach dem Öffnen der DB wieder gesetzt (nicht mit zurückgedreht) */
  keepSettings?: Record<string, unknown>;
}

const KEEP_SETTINGS = ['backupDir', 'backupKeep', 'backupIntervalHours'] as const;

/**
 * Beim Start (Instanz-Sperre gehalten, DB noch nicht geöffnet): vorgemerkte Wiederherstellung ausführen.
 * Reihenfolge: Kopie nach `.restore-tmp` -> umbenennen auf hotspot.sqlite -> -wal/-shm der alten DB löschen -> Vormerkung löschen.
 * Bricht der Prozess irgendwo ab, bleibt die Vormerkung stehen und der nächste Start wiederholt alles (die neue DB wird
 * nie mit einem WAL der alten geöffnet). `onStep` nur für Tests (Absturz an einer Stelle simulieren).
 */
export function applyPendingRestore(dataDir: string, onStep?: (step: 'copied' | 'renamed' | 'cleaned') => void): PendingRestoreResult | null {
  const pendingFile = path.join(dataDir, PENDING);
  if (!fs.existsSync(pendingFile)) return null;
  let p: { db?: unknown; id?: unknown; settings?: unknown };
  try {
    p = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as typeof p;
  } catch {
    p = {};
  }
  const keepSettings: Record<string, unknown> = {};
  if (p.settings && typeof p.settings === 'object') for (const k of KEEP_SETTINGS) if (k in p.settings) keepSettings[k] = (p.settings as Record<string, unknown>)[k];
  const id = typeof p.id === 'string' && SNAPSHOT_RE.test(p.id) ? p.id : null;
  const src = typeof p.db === 'string' && path.isAbsolute(p.db) && path.basename(p.db) === 'hotspot.sqlite' ? p.db : null;
  try {
    if (!src || !id) throw new HttpError(400, 'restore_invalid', 'Vormerkung ungültig');
    inspectDbFile(src); // erneut prüfen: Sicherung könnte seit dem Vormerken verändert worden sein
  } catch (err) {
    fs.rmSync(pendingFile, { force: true });
    return { ok: false, id, code: err instanceof HttpError ? err.code : 'restore_failed' };
  }
  const target = path.join(dataDir, 'hotspot.sqlite');
  const tmp = target + '.restore-tmp';
  const dropWal = () => {
    for (const suffix of ['-wal', '-shm', '-journal']) retrySync(() => fs.rmSync(target + suffix, { force: true }));
  };
  retrySync(() => fs.copyFileSync(src, tmp));
  onStep?.('copied');
  // WAL/SHM der alten DB VOR dem Umbenennen löschen: die neue Datei liegt nie neben einem fremden WAL
  dropWal();
  retrySync(() => fs.renameSync(tmp, target));
  onStep?.('renamed');
  dropWal(); // idempotent (falls ein abgebrochener Vorlauf dazwischen lag)
  onStep?.('cleaned');
  fs.rmSync(pendingFile, { force: true });
  return { ok: true, id, keepSettings };
}

export class BackupService {
  private running: Promise<unknown> = Promise.resolve();
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly deps: { db: DB; dataDir: string; settings: SettingsStore; log: (msg: string, extra?: unknown) => void; onChange?: () => void };
  /** Testhaken: simulierter Absturz/Anhalten während des Sicherns */
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

  /** Sicherungen im Zielordner; wirft nie (unlesbarer Ordner -> leere Liste + Fehlercode für die Oberfläche). */
  listSafe(): { items: SnapshotInfo[]; error: string | null } {
    const out: SnapshotInfo[] = [];
    try {
      const dir = this.dir();
      if (!fs.existsSync(dir)) return { items: [], error: null };
      if (!isRealDir(dir)) return { items: [], error: 'not_a_dir' };
      for (const name of fs.readdirSync(dir)) {
        const m = SNAPSHOT_RE.exec(name);
        if (!m || !isRealDir(path.join(dir, name))) continue;
        const man = readManifest(path.join(dir, name));
        if (!man) continue;
        out.push({ id: name, reason: m[3] as SnapshotReason, createdAt: man.createdAt ?? 0, appVersion: man.appVersion ?? null, schemaVersion: man.schemaVersion ?? null, files: man.files ?? 0, bytes: man.bytes ?? 0, dbBytes: man.dbBytes ?? 0, missing: man.missing ?? 0 });
      }
    } catch (err) {
      return { items: [], error: (err as NodeJS.ErrnoException).code ?? 'unreadable' };
    }
    return { items: out.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)), error: null };
  }

  list(): SnapshotInfo[] {
    return this.listSafe().items;
  }

  /** Pfad eines Snapshots aus seiner ID – nur gültige Namen direkt im Zielordner, kein Symlink. */
  private resolve(id: string): string {
    if (!SNAPSHOT_RE.test(id)) throw new HttpError(400, 'restore_invalid', 'Ungültige Sicherungs-ID', 'id');
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

  /**
   * Alles in try/finally: ein Dateisystemfehler (EPERM durch Virenscanner, Laufwerk weg …) darf weder den Prozess beenden
   * noch „busy“ hängen lassen.
   */
  private async doCreate(reason: SnapshotReason): Promise<SnapshotInfo> {
    let tmp: string | null = null;
    try {
      this.busy = true;
      this.deps.onChange?.();
      const target = this.dir();
      const problem = backupDirProblem(this.deps.settings.get().backupDir, this.deps.dataDir);
      if (problem) throw new HttpError(400, 'backup_dir_invalid', 'Zielordner ungültig', problem);
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.accessSync(target, fs.constants.W_OK);
      } catch {
        throw new HttpError(400, 'backup_dir_not_writable', 'Zielordner kann nicht angelegt/beschrieben werden', target);
      }
      if (!isRealDir(target)) throw new HttpError(400, 'backup_dir_not_writable', 'Zielordner ist kein Ordner', target);
      // Reste abgebrochener Läufe (Absturz/kill, nicht löschbare Sicherungen) entfernen – es läuft immer nur ein Snapshot
      for (const name of fs.readdirSync(target)) {
        if (name.endsWith('.partial') && SNAPSHOT_RE.test(name.slice(0, -8))) rmLogged(path.join(target, name), this.deps.log);
      }
      const prev = this.list()[0] ?? null;
      let id = `snapshot-${stamp()}-${reason}`;
      for (let i = 2; fs.existsSync(path.join(target, id)) || fs.existsSync(path.join(target, id + '.partial')); i++) id = `snapshot-${stamp()}-${i}-${reason}`;
      tmp = path.join(target, id + '.partial');
      fs.mkdirSync(tmp);
      const dbFile = path.join(tmp, 'hotspot.sqlite');
      await sqliteBackup(this.deps.db, dbFile, { rate: 256 });
      await this.onStep?.('db');
      // eigenständige Einzeldatei (kein WAL) + Liste der referenzierten Dateien genau aus dieser Kopie
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
        // inkrementell: gleiche Datei aus dem vorigen Snapshot verlinken (auch wenn der Zielordner auf einem anderen Laufwerk liegt);
        // verschwindet sie dort gerade (vorige Sicherung gelöscht), aus dem Datenordner holen
        const sources = [...(prevFiles ? [path.join(prevFiles, rel)] : []), path.join(dataFiles, rel)];
        let ok = false;
        for (const src of sources) {
          try {
            await linkOrCopy(src, dest);
            bytes += (await fsp.stat(dest)).size;
            files++;
            ok = true;
            break;
          } catch {
            /* nächste Quelle */
          }
        }
        if (!ok) missing++; // Originaldatei fehlt (z. B. gerade gelöscht) – Snapshot bleibt nutzbar
        if (i === Math.floor(hashes.length / 2)) await this.onStep?.('files');
      }
      if (!hashes.length) await this.onStep?.('files');
      const info: SnapshotInfo = { id, reason, createdAt: Date.now(), appVersion: APP_VERSION, schemaVersion, files, bytes, dbBytes: fs.statSync(dbFile).size, missing };
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ format: 'uni-hotspot-snapshot', formatVersion: 1, ...info }, null, 2));
      const done = tmp;
      retrySync(() => fs.renameSync(done, path.join(target, id)));
      tmp = null;
      this.deps.log(`Sicherung ${id}: ${files} Datei(en)${missing ? `, ${missing} fehlend` : ''}`);
      this.prune();
      return info;
    } catch (err) {
      if (tmp) rmLogged(tmp, this.deps.log);
      if (err instanceof HttpError) throw err;
      this.deps.log('Sicherung fehlgeschlagen', { code: (err as NodeJS.ErrnoException).code });
      throw new HttpError(500, 'backup_failed', 'Sicherung fehlgeschlagen', (err as NodeJS.ErrnoException).code ?? 'unknown');
    } finally {
      this.busy = false;
      this.deps.onChange?.();
    }
  }

  /** Aufbewahrung: nur automatische Snapshots werden ausgedünnt (manuelle und "vor Wiederherstellung" bleiben). Wirft nie. */
  private prune(): void {
    try {
      const keep = this.deps.settings.get().backupKeep;
      for (const s of this.list().filter((x) => x.reason === 'auto').slice(keep)) {
        try {
          this.remove(s.id);
        } catch (err) {
          this.deps.log('Alte Sicherung konnte nicht entfernt werden', { code: (err as HttpError).code });
        }
      }
    } catch (err) {
      this.deps.log('Aufbewahrung fehlgeschlagen', { code: (err as NodeJS.ErrnoException).code });
    }
  }

  /**
   * Erst in `<id>.partial` umbenennen (gilt sofort nicht mehr als Sicherung), dann löschen. Scheitert das Löschen
   * (gesperrte Datei), räumt der nächste Sicherungslauf den Rest weg.
   */
  remove(id: string): void {
    const p = this.resolve(id);
    const doomed = p + '.partial';
    try {
      retrySync(() => fs.renameSync(p, doomed));
    } catch (err) {
      throw new HttpError(409, 'backup_failed', 'Sicherung ist gesperrt', (err as NodeJS.ErrnoException).code ?? 'locked');
    }
    rmLogged(doomed, this.deps.log);
    this.deps.onChange?.();
  }

  /**
   * Wiederherstellung vormerken: prüfen, Ist-Zustand sichern, fehlende Originaldateien übernehmen (Hash geprüft),
   * Vormerkung schreiben. Der Austausch der DB passiert beim Neustart (applyPendingRestore).
   */
  async stageRestore(id: string): Promise<{ preRestore: string; missingFiles: number; schemaVersion: number }> {
    try {
      return await this.doStageRestore(id);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      this.deps.log('Wiederherstellung vorbereiten fehlgeschlagen', { code: (err as NodeJS.ErrnoException).code });
      throw new HttpError(500, 'restore_failed', 'Wiederherstellung fehlgeschlagen', (err as NodeJS.ErrnoException).code ?? 'unknown');
    }
  }

  private async doStageRestore(id: string): Promise<{ preRestore: string; missingFiles: number; schemaVersion: number }> {
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
      // manipulierte Sicherung: Inhalt muss zum Namen (SHA-256) passen, sonst würde der Speicher falsche Inhalte ausliefern
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
    // Sicherungs-Einstellungen gehören nicht zum wiederhergestellten Stand: nach dem Austausch wieder setzen
    const st = this.deps.settings.get();
    const settings = Object.fromEntries(KEEP_SETTINGS.map((k) => [k, st[k]]));
    fs.writeFileSync(tmp, JSON.stringify({ id, db: dbFile, stagedAt: Date.now(), settings }));
    retrySync(() => fs.renameSync(tmp, pendingFile));
    this.deps.log(`Wiederherstellung von ${id} vorgemerkt (Ist-Zustand gesichert als ${pre.id})`);
    return { preRestore: pre.id, missingFiles, schemaVersion: version };
  }

  /** Automatische Sicherung: prüft stündlich (erstmals nach 2 min), ob die letzte automatische älter als das Intervall ist. */
  start(): void {
    this.stopped = false;
    const schedule = (ms: number) => {
      this.timer = setTimeout(() => {
        try {
          this.autoTick();
        } finally {
          if (!this.stopped) schedule(3_600_000);
        }
      }, ms);
      this.timer.unref();
    };
    schedule(120_000);
  }

  /** Fällige automatische Sicherung anstoßen (true = gestartet). Wirft nie (läuft im Timer). */
  autoTick(): boolean {
    try {
      if (this.stopped || this.busy) return false;
      const hours = this.deps.settings.get().backupIntervalHours;
      if (!hours) return false;
      const last = this.list().find((s) => s.reason === 'auto');
      if (last && Date.now() - last.createdAt < hours * 3_600_000 - 60_000) return false;
      void this.create('auto').catch((err: unknown) => this.deps.log('Automatische Sicherung fehlgeschlagen', { code: (err as HttpError).code, detail: (err as HttpError).detail }));
      return true;
    } catch (err) {
      this.deps.log('Automatische Sicherung: Prüfung fehlgeschlagen', { code: (err as NodeJS.ErrnoException).code });
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
