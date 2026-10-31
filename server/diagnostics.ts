import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from './config.ts';
import { SCHEMA_VERSION } from './db.ts';
import { hasModel } from './ollama/status.ts';
import { redactText, sanitizeLogLines } from './logs.ts';
import type { Services } from './app.ts';

/**
 * Diagnose: Versionen, Ollama-/Werkzeug-Status, Datenordner (Größe, frei, beschreibbar), Zähler, Sicherungen.
 * Enthält keine Inhalte aus Dokumenten (nur Zahlen, Modell-/Werkzeugnamen, Pfade des Programms/Datenordners).
 */
export async function collectDiagnostics(s: Services): Promise<Record<string, unknown>> {
  const dataDir = s.config.dataDir;
  const errors: string[] = [];
  /** einzelner Teil darf scheitern (unlesbarer Ordner, gesperrte Datei) – die Diagnose liefert trotzdem (nie 500) */
  const safe = <T>(label: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      errors.push(`${label}:${(err as NodeJS.ErrnoException).code ?? 'error'}`);
      return fallback;
    }
  };
  const writable = safe('writable', () => (fs.accessSync(dataDir, fs.constants.W_OK), true), false);
  const freeBytes = safe(
    'free',
    () => {
      const st = fs.statfsSync(dataDir);
      return st.bavail * st.bsize;
    },
    null as number | null,
  );
  const fileSize = (f: string) => safe(`stat`, () => (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  const dbBytes = fileSize(path.join(dataDir, 'hotspot.sqlite')) + fileSize(path.join(dataDir, 'hotspot.sqlite-wal'));
  // Originaldateien aus der DB (eine Zeile je Inhalt) statt jede Datei per stat – bei 10 000+ Dateien sonst Sekunden je Aufruf
  const files = safe('files', () => s.db.prepare('SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM (SELECT max(size) AS size FROM sources GROUP BY sha256)').get() as { n: number; bytes: number }, { n: 0, bytes: 0 });
  const backupDir = safe('backupDir', () => s.backup.dir(), '');
  const { items: backups, error: backupError } = s.backup.listSafe();
  if (backupError) errors.push(`backups:${backupError}`);
  // logisch (Hardlinks zählen mehrfach), aus den Manifesten – kein Durchlaufen der Snapshot-Ordner
  const backupBytes = backups.reduce((n, b) => n + b.bytes + b.dbBytes, 0);
  const logBytes = safe('logs', () => fs.readdirSync(path.join(dataDir, 'logs')).reduce((n, f) => n + fileSize(path.join(dataDir, 'logs', f)), 0), 0);
  const st = s.settings.get();
  const ollama = s.monitor.status;
  const tools = safe('tools', () => s.media.tools(), { ffmpeg: null, whisper: null, models: {} } as unknown as ReturnType<Services['media']['tools']>);
  const sqlite = safe('sqlite', () => (s.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v, '?');
  const q = safe('queue', () => s.queueStatus(), null);
  return {
    app: {
      version: APP_VERSION,
      schema: SCHEMA_VERSION,
      mock: s.config.mockOllama,
      platform: `${process.platform} ${process.arch}`,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      chrome: process.versions.chrome ?? null,
      sqlite,
      uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
      rssBytes: process.memoryUsage().rss,
      vectorCacheBytes: s.vectors.memoryBytes(),
      pdfExport: !!s.config.printToPdf,
    },
    ollama: {
      reachable: ollama.reachable,
      url: ollama.url,
      version: ollama.version,
      models: ollama.models.length,
      running: ollama.running.map((r) => ({ name: r.name, gpuPercent: r.gpuPercent })),
      // je Modell eine Zeile (gemma3:4b für Chat und Bilder nur einmal)
      required: [...new Set([st.chatModel, st.embeddingModel, st.visionModel])].map((model) => ({
        model,
        roles: (['chat', 'embedding', 'vision'] as const).filter((r) => ({ chat: st.chatModel, embedding: st.embeddingModel, vision: st.visionModel })[r] === model),
        installed: ollama.reachable ? hasModel(ollama, model) : null,
      })),
      error: ollama.error ? redactText(ollama.error).slice(0, 200) : null,
    },
    tools: { ffmpeg: !!tools.ffmpeg, whisper: !!tools.whisper, whisperModels: Object.keys(tools.models).sort() },
    dataDir: {
      path: dataDir,
      writable,
      freeBytes,
      // OneDrive & Co. synchronisieren SQLite-Dateien während des Schreibens -> Warnhinweis
      synced: /onedrive|dropbox|google drive|icloud/i.test(dataDir),
      sizes: { db: dbBytes, files: files.bytes, backups: backupBytes, logs: logBytes },
      fileCount: files.n,
    },
    counts: safe('counts', () => s.library.stats(), null),
    // nur Zähler – keine Dateinamen laufender Verarbeitungen, keine Fehlertexte
    queue: q && {
      ingest: { queued: q.ingest.queued, processing: q.ingest.processing.length },
      embed: { state: q.embed.state, pending: q.embed.pending, done: q.embed.done, failed: q.embed.failed },
      media: q.media,
      learn: q.learn,
    },
    backups: { dir: backupDir, count: backups.length, last: backups[0]?.createdAt ?? null, intervalHours: st.backupIntervalHours, keep: st.backupKeep, error: backupError },
    errors,
  };
}

/** Text für „Log exportieren“: Diagnose (Pfade anonymisiert) + bereinigte Logzeilen – ohne Dokumentinhalte. */
export async function diagnosticsReport(s: Services): Promise<string> {
  const diag = await collectDiagnostics(s);
  let raw = '';
  for (const f of [`${s.logFile}.1`, s.logFile]) {
    try {
      const st = fs.statSync(f);
      // höchstens die letzten 4 MB je Datei lesen
      const fd = fs.openSync(f, 'r');
      try {
        const len = Math.min(st.size, 4 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        raw += buf.toString('utf8') + '\n';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* Datei fehlt */
    }
  }
  return [
    `Uni-Hotspot Diagnose – ${new Date().toISOString()}`,
    'Enthält keine Dokumentinhalte, Dateinamen oder Chat-Texte; Benutzerpfade sind anonymisiert.',
    '',
    redactText(JSON.stringify(diag, null, 2)),
    '',
    '--- Log (bereinigt, neueste zuletzt) ---',
    ...sanitizeLogLines(raw),
    '',
  ].join('\n');
}
