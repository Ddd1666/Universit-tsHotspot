import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION } from './config.ts';
import { SCHEMA_VERSION } from './db.ts';
import { hasModel } from './ollama/status.ts';
import { redactText, sanitizeLogLines } from './logs.ts';
import type { Services } from './app.ts';

/** Ordnergröße (Bytes, Anzahl Dateien) – Symlinks werden nicht verfolgt. */
async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string) => {
    let list: fs.Dirent[];
    try {
      list = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          bytes += (await fsp.stat(p)).size;
          files++;
        } catch {
          /* gerade gelöscht */
        }
      }
    }
  };
  await walk(dir);
  return { bytes, files };
}

/**
 * Diagnose: Versionen, Ollama-/Werkzeug-Status, Datenordner (Größe, frei, beschreibbar), Zähler, Sicherungen.
 * Enthält keine Inhalte aus Dokumenten (nur Zahlen, Modell-/Werkzeugnamen, Pfade des Programms/Datenordners).
 */
export async function collectDiagnostics(s: Services): Promise<Record<string, unknown>> {
  const dataDir = s.config.dataDir;
  let writable = true;
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  let freeBytes: number | null;
  try {
    const st = fs.statfsSync(dataDir);
    freeBytes = st.bavail * st.bsize;
  } catch {
    freeBytes = null;
  }
  const sizeOf = async (sub: string) => (await dirSize(path.join(dataDir, sub))).bytes;
  const dbBytes = ['hotspot.sqlite', 'hotspot.sqlite-wal'].reduce((n, f) => {
    try {
      return n + fs.statSync(path.join(dataDir, f)).size;
    } catch {
      return n;
    }
  }, 0);
  const files = await dirSize(path.join(dataDir, 'files'));
  const backupDir = s.backup.dir();
  const backups = s.backup.list();
  const st = s.settings.get();
  const ollama = s.monitor.status;
  const tools = s.media.tools();
  const sqlite = (s.db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
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
      required: [
        { role: 'chat', model: st.chatModel },
        { role: 'embedding', model: st.embeddingModel },
        { role: 'vision', model: st.visionModel },
      ].map((r) => ({ ...r, installed: ollama.reachable ? hasModel(ollama, r.model) : null })),
      error: ollama.error ? redactText(ollama.error).slice(0, 200) : null,
    },
    tools: { ffmpeg: !!tools.ffmpeg, whisper: !!tools.whisper, whisperModels: Object.keys(tools.models).sort() },
    dataDir: {
      path: dataDir,
      writable,
      freeBytes,
      // OneDrive & Co. synchronisieren SQLite-Dateien während des Schreibens -> Warnhinweis
      synced: /onedrive|dropbox|google drive|icloud/i.test(dataDir),
      sizes: { db: dbBytes, files: files.bytes, backups: backupDir.startsWith(dataDir) ? await sizeOf(path.relative(dataDir, backupDir)) : null, logs: await sizeOf('logs') },
      fileCount: files.files,
    },
    counts: s.library.stats(),
    queue: s.queueStatus(),
    backups: { dir: backupDir, count: backups.length, last: backups[0]?.createdAt ?? null, intervalHours: st.backupIntervalHours, keep: st.backupKeep },
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
