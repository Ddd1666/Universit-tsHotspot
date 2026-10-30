import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { HttpError } from '../library.ts';
import { TooLargeError } from '../storage.ts';
import { importLibrary, writeExport } from '../transfer.ts';
import { collectDiagnostics, diagnosticsReport } from '../diagnostics.ts';
import { getNote } from '../learn/data.ts';
import { contentDisposition } from './routes.ts';

const idParam = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;
const snapParam = { type: 'object', properties: { id: { type: 'string', pattern: '^snapshot-[0-9a-z-]{1,80}$' } }, required: ['id'] } as const;
const MAX_IMPORT = 64 * 1024 ** 3;

const day = () => new Date().toISOString().slice(0, 10);
// eslint-disable-next-line no-control-regex
const fileSafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'Fach';

/** CSV-Zelle (RFC 4180) mit Schutz gegen Formel-Injektion in Tabellenprogrammen. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Sicherung, Wiederherstellung, Export/Import, Diagnose (Phase 4). Token/Host/Origin-Prüfung wie alle /api-Routen. */
export function registerMaintenanceRoutes(app: FastifyInstance, s: Services): void {
  /* ------------------------------------------------------------ Sicherungen */

  const backupState = () => {
    const st = s.settings.get();
    return { dir: s.backup.dir(), defaultDir: path.join(s.config.dataDir, 'backups'), busy: s.backup.isBusy, items: s.backup.list(), keep: st.backupKeep, intervalHours: st.backupIntervalHours, backupDir: st.backupDir, canRestart: !!s.config.requestRestart };
  };

  app.get('/api/backups', async () => backupState());

  app.post('/api/backups', async () => ({ snapshot: await s.backup.create('manual'), ...backupState() }));

  app.delete('/api/backups/:id', { schema: { params: snapParam } }, async (req) => {
    s.backup.remove((req.params as { id: string }).id);
    return backupState();
  });

  app.post(
    '/api/backups/:id/restore',
    { schema: { params: snapParam, body: { type: 'object', properties: { confirm: { const: true } }, required: ['confirm'], additionalProperties: false } } },
    async (req) => {
      if (s.backup.isBusy) throw new HttpError(409, 'backup_busy', 'Es läuft gerade eine Sicherung');
      const r = await s.backup.stageRestore((req.params as { id: string }).id);
      const restarting = !!s.config.requestRestart;
      // Antwort erst senden, dann neu starten (Austausch der DB passiert beim Start)
      if (restarting) setTimeout(() => s.config.requestRestart?.(), 300);
      return { ...r, restarting };
    },
  );

  /* ------------------------------------------------------------ Export / Import */

  app.get(
    '/api/library/export',
    { schema: { querystring: { type: 'object', properties: { subject: { type: 'string', pattern: '^(all|\\d+)$' }, t: { type: 'string' } } } } },
    async (req, reply) => {
      const q = (req.query as { subject?: string }).subject ?? 'all';
      const scope = q === 'all' ? ({ kind: 'all' } as const) : ({ kind: 'subject', id: Number(q) } as const);
      let label = 'Bibliothek';
      if (scope.kind === 'subject') {
        const sub = s.db.prepare('SELECT name FROM subjects WHERE id = ?').get(scope.id) as { name: string } | undefined;
        if (!sub) throw new HttpError(404, 'not_found', 'Fach nicht gefunden');
        label = fileSafe(sub.name);
      }
      const pass = new PassThrough();
      reply.header('content-disposition', contentDisposition('attachment', `Uni-Hotspot-Export-${label}-${day()}.zip`));
      reply.type('application/zip');
      void writeExport(s.db, s.blobs, scope, pass, s.blobs.tmpDir).catch((err: Error) => {
        app.log.info({ extra: { code: (err as NodeJS.ErrnoException).code } }, 'Export abgebrochen');
        pass.destroy(err);
      });
      return reply.send(pass);
    },
  );

  app.post('/api/library/import', { bodyLimit: MAX_IMPORT }, async (req) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/octet-stream')) throw new HttpError(415, 'unsupported_media', 'Upload als application/octet-stream erwartet');
    if (Number(req.headers['content-length'] ?? 0) > MAX_IMPORT) throw new TooLargeError(MAX_IMPORT);
    const tmp = path.join(s.blobs.tmpDir, `import-${crypto.randomBytes(8).toString('hex')}.zip`);
    try {
      let size = 0;
      await pipeline(
        req.body as Readable,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const c of src) {
            size += c.length;
            if (size > MAX_IMPORT) throw new TooLargeError(MAX_IMPORT);
            yield c;
          }
        },
        fs.createWriteStream(tmp, { flags: 'wx' }),
      );
      const report = await importLibrary({ db: s.db, blobs: s.blobs }, tmp);
      s.bus.emit({ type: 'subjects' });
      if (report.sources.requeued) s.ingest.wakeUp();
      s.embed.notify();
      s.notifyQueue();
      return report;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  /** Karteikarten als CSV (UTF-8 mit BOM für Excel; in Anki über „Importieren“ – Spalte 1/2 = Vorder-/Rückseite). */
  app.get('/api/cards/export.csv', { schema: { querystring: { type: 'object', properties: { subject: { type: 'integer', minimum: 1 } } } } }, async (req, reply) => {
    const sub = (req.query as { subject?: number }).subject;
    const rows = s.db
      .prepare(
        `SELECT c.front, c.back, c.type, c.status, sub.name AS subject, coalesce(src.name, c.source_name) AS source, c.due, c.interval_days, c.ease, c.reps, c.lapses
         FROM cards c LEFT JOIN subjects sub ON sub.id = c.subject_id LEFT JOIN sources src ON src.id = c.source_id
         ${sub ? 'WHERE c.subject_id = ?' : ''} ORDER BY c.id`,
      )
      .all(...(sub ? [sub] : [])) as Record<string, unknown>[];
    const de = s.settings.get().language === 'de';
    const head = de
      ? ['Vorderseite', 'Rückseite', 'Typ', 'Status', 'Fach', 'Quelle', 'Fällig', 'Intervall (Tage)', 'Leichtigkeit', 'Wiederholungen', 'Fehlversuche']
      : ['Front', 'Back', 'Type', 'Status', 'Subject', 'Source', 'Due', 'Interval (days)', 'Ease', 'Reviews', 'Lapses'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) {
      const due = typeof r.due === 'number' ? new Date(r.due).toISOString().slice(0, 10) : '';
      lines.push([r.front, r.back, r.type, r.status, r.subject, r.source, due, r.interval_days, r.ease, r.reps, r.lapses].map(csvCell).join(','));
    }
    reply.header('content-disposition', contentDisposition('attachment', `${de ? 'Karteikarten' : 'Flashcards'}-${day()}.csv`));
    return reply.type('text/csv; charset=utf-8').send('﻿' + lines.join('\r\n') + '\r\n');
  });

  /** Notiz als PDF (nur Desktop: Electron printToPDF). Im Browser-Modus druckt die Oberfläche selbst (Druckansicht). */
  app.get('/api/notes/:id/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const id = (req.params as { id: number }).id;
    const note = getNote(s.db, id);
    if (!s.config.printToPdf) throw new HttpError(501, 'pdf_unavailable', 'PDF-Export nur in der Desktop-App – im Browser über „Drucken → Als PDF speichern“');
    const pdf = await s.config.printToPdf(`/#/learn/notes?note=${id}&print=1`);
    reply.header('content-disposition', contentDisposition('attachment', `${fileSafe(note.title)}.pdf`));
    return reply.type('application/pdf').send(pdf);
  });

  /* ------------------------------------------------------------ Diagnose */

  app.get('/api/diagnostics', async () => collectDiagnostics(s));

  app.get('/api/diagnostics/report', async (_req, reply) => {
    reply.header('content-disposition', contentDisposition('attachment', `Uni-Hotspot-Diagnose-${day()}.txt`));
    return reply.type('text/plain; charset=utf-8').send(await diagnosticsReport(s));
  });
}
