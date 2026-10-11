import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { APP_VERSION, LOCAL_CONFIG_FILE, readLocalConfig, writeLocalConfig } from '../config.ts';
import { HttpError, SOURCE_LIST_LIMIT } from '../library.ts';
import { hasModel } from '../ollama/status.ts';
import { TooLargeError } from '../storage.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { hybridSearch, parseScope } from '../search/hybrid.ts';
import { openSse } from './sse.ts';
import type { Services } from '../app.ts';

const idParam = { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'] } as const;

/** Sichere Content-Disposition (RFC 6266/5987) – Dateiname aus der DB, nie aus der Anfrage. */
function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Nur diese Typen dürfen im Browser "geöffnet" werden; alles andere wird als Download erzwungen (kein HTML/SVG -> kein XSS). */
function inlineType(kind: string, mime: string): string | null {
  if (kind === 'pdf') return 'application/pdf';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return mime;
  if (['text', 'markdown', 'code', 'json', 'csv'].includes(kind)) return 'text/plain; charset=utf-8';
  return null;
}

export function registerRoutes(app: FastifyInstance, s: Services): void {
  // Upload-Rohdaten werden gestreamt (nicht gepuffert); Größe wird beim Schreiben begrenzt.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message, detail: err.detail });
    if (err instanceof TooLargeError) return reply.code(413).send({ error: 'too_large', message: err.message, detail: String(Math.round(err.limit / 1024 / 1024)) });
    const e = err as { validation?: unknown; statusCode?: number; message: string };
    if (e.validation) return reply.code(400).send({ error: 'invalid_request', message: e.message });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Interner Fehler – Details im Log' });
  });

  /* ------------------------------------------------------------ Basis */

  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION, mock: s.config.mockOllama }));

  app.get('/api/bootstrap', async () => ({
    version: APP_VERSION,
    mock: s.config.mockOllama,
    dataDir: s.config.dataDir,
    platform: process.platform,
    settings: s.settings.get(),
    defaults: DEFAULT_SETTINGS,
    subjects: s.library.listSubjects(),
    ollama: s.monitor.status,
    queue: s.queueStatus(),
    stats: s.library.stats(),
    vectorStore: s.vectors.kind,
  }));

  app.get('/api/events', async (_req, reply) => {
    const sse = openSse(reply);
    sse.send('hello', { version: APP_VERSION });
    const off = s.bus.on((e) => sse.send(e.type, e));
    const ping = setInterval(() => sse.comment('ping'), 25_000);
    sse.onClose(() => {
      off();
      clearInterval(ping);
    });
  });

  app.get('/api/stats', async () => ({ ...s.library.stats(), queue: s.queueStatus(), vectorStore: s.vectors.kind, vectorCacheBytes: s.vectors.memoryBytes() }));

  /* ------------------------------------------------------------ Einstellungen / Ollama */

  app.get('/api/settings', async () => ({
    settings: s.settings.get(),
    defaults: DEFAULT_SETTINGS,
    dataDir: s.config.dataDir,
    dataDirConfigured: readLocalConfig().dataDir ?? null,
    configFile: LOCAL_CONFIG_FILE,
  }));

  app.put('/api/settings', { schema: { body: { type: 'object', additionalProperties: true } } }, async (req) => {
    let next;
    try {
      next = s.settings.update(req.body as Record<string, unknown>);
    } catch (err) {
      throw new HttpError(400, 'invalid_setting', (err as Error).message, (err as Error).message.split(':')[0]);
    }
    s.bus.emit({ type: 'settings', settings: next });
    return { settings: next, queue: s.queueStatus() };
  });

  app.put(
    '/api/settings/data-dir',
    { schema: { body: { type: 'object', properties: { path: { type: ['string', 'null'], maxLength: 400 } }, required: ['path'] } } },
    async (req) => {
      const p = (req.body as { path: string | null }).path;
      if (p === null || p.trim() === '') {
        const cfg = readLocalConfig();
        delete cfg.dataDir;
        writeLocalConfig(cfg);
        return { ok: true, restartRequired: true };
      }
      // eslint-disable-next-line no-control-regex
      if (!path.isAbsolute(p) || /[\u0000-\u001f]/.test(p)) throw new HttpError(400, 'invalid_path', 'Bitte einen absoluten Pfad angeben');
      try {
        fs.mkdirSync(p, { recursive: true });
        fs.accessSync(p, fs.constants.W_OK);
      } catch {
        throw new HttpError(400, 'not_writable', 'Ordner kann nicht angelegt/beschrieben werden');
      }
      writeLocalConfig({ ...readLocalConfig(), dataDir: path.resolve(p) });
      return { ok: true, restartRequired: true };
    },
  );

  app.get('/api/ollama', async () => s.monitor.status);
  app.post('/api/ollama/refresh', async () => s.monitor.refresh());

  // Re-Index verwirft alle Vektoren -> nur, wenn das Zielmodell wirklich installiert ist
  app.post('/api/index/reindex', async () => {
    const model = s.settings.get().embeddingModel;
    const status = await s.monitor.refresh();
    if (!status.reachable) throw new HttpError(409, 'ollama_unreachable', 'Ollama ist nicht erreichbar – Re-Index nicht möglich');
    if (!hasModel(status, model)) throw new HttpError(409, 'model_missing', `Embedding-Modell "${model}" ist nicht installiert (ollama pull ${model})`, model);
    s.embed.reindex();
    return { queue: s.queueStatus() };
  });

  /* ------------------------------------------------------------ Fächer */

  app.get('/api/subjects', async () => s.library.listSubjects());

  const subjectBody = {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } },
    additionalProperties: false,
  } as const;

  app.post('/api/subjects', { schema: { body: { ...subjectBody, required: ['name', 'color'] } } }, async (req) => {
    const b = req.body as { name: string; color: string };
    return s.library.createSubject(b.name, b.color);
  });

  app.patch('/api/subjects/:id', { schema: { params: idParam, body: subjectBody } }, async (req) => {
    const { id } = req.params as { id: number };
    return s.library.updateSubject(id, req.body as { name?: string; color?: string });
  });

  app.delete(
    '/api/subjects/:id',
    { schema: { params: idParam, querystring: { type: 'object', properties: { deleteSources: { type: 'boolean' } } } } },
    async (req) => {
      const { id } = req.params as { id: number };
      await s.library.deleteSubject(id, !!(req.query as { deleteSources?: boolean }).deleteSources);
      return { ok: true };
    },
  );

  /* ------------------------------------------------------------ Quellen */

  app.get(
    '/api/sources',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            subject: { type: 'string', pattern: '^(all|none|\\d+)$' },
            parent: { type: 'integer', minimum: 1 },
            q: { type: 'string', maxLength: 200 },
            status: { type: 'string', maxLength: 20 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { subject?: string; parent?: number; q?: string; status?: string };
      const subjectId = q.subject === 'none' ? 'none' : q.subject && q.subject !== 'all' ? Number(q.subject) : undefined;
      const { items, total } = s.library.listSources({ subjectId, parentId: q.parent, q: q.q, status: q.status });
      return { items, total, limit: SOURCE_LIST_LIMIT };
    },
  );

  app.get(
    '/api/sources/:id',
    { schema: { params: idParam, querystring: { type: 'object', properties: { around: { type: 'integer', minimum: 1 } } } } },
    async (req) => {
      const { id } = req.params as { id: number };
      const source = s.library.getSource(id);
      if (!source) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
      const around = (req.query as { around?: number }).around;
      return {
        source,
        chunks: s.library.chunkPreview(id, { limit: 40, aroundChunkId: around }),
        children: source.childCount ? s.library.listSources({ parentId: id, limit: 500 }).items : [],
      };
    },
  );

  app.patch(
    '/api/sources/:id',
    {
      schema: {
        params: idParam,
        body: { type: 'object', properties: { subjectId: { type: ['integer', 'null'] }, name: { type: 'string', minLength: 1, maxLength: 255 } }, additionalProperties: false },
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const b = req.body as { subjectId?: number | null; name?: string };
      let out = s.library.getSource(id);
      if (!out) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
      if (b.subjectId !== undefined) out = s.library.moveSource(id, b.subjectId);
      if (b.name !== undefined) out = s.library.renameSource(id, b.name);
      return out;
    },
  );

  app.delete('/api/sources/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: number };
    if (!s.library.getSource(id)) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
    const removed = await s.library.deleteSources([id]);
    s.notifyQueue();
    return { ok: true, removed };
  });

  app.post('/api/sources/:id/retry', { schema: { params: idParam } }, async (req) => s.ingest.retry((req.params as { id: number }).id));

  app.get(
    '/api/sources/:id/file',
    { schema: { params: idParam, querystring: { type: 'object', properties: { download: { type: 'string' }, t: { type: 'string' } } } } },
    async (req, reply: FastifyReply) => {
      const { id } = req.params as { id: number };
      const src = s.library.getSource(id);
      if (!src) throw new HttpError(404, 'not_found', 'Quelle nicht gefunden');
      const file = s.blobs.pathFor(src.sha256); // Pfad nur aus validiertem Hash
      if (!fs.existsSync(file)) throw new HttpError(404, 'file_missing', 'Originaldatei fehlt im Datenordner');
      const wantsDownload = (req.query as { download?: string }).download === '1';
      const inline = wantsDownload ? null : inlineType(src.kind, src.mime);
      reply.header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', src.name));
      reply.header('cache-control', 'private, no-store');
      if (inline && inline !== 'application/pdf') {
        reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      }
      reply.type(inline ?? 'application/octet-stream');
      return reply.send(fs.createReadStream(file));
    },
  );

  /* ------------------------------------------------------------ Import */

  app.post('/api/import', { bodyLimit: 1024 * 1024 * 1024 * 16 }, async (req) => {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('application/octet-stream')) throw new HttpError(415, 'unsupported_media', 'Upload als application/octet-stream erwartet');
    const max = s.settings.get().maxFileSizeMB * 1024 * 1024;
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > max) throw new TooLargeError(max);
    const header = (name: string) => {
      const v = req.headers[name];
      if (typeof v !== 'string' || !v) return null;
      try {
        return decodeURIComponent(v);
      } catch {
        throw new HttpError(400, 'invalid_header', `Header ${name} ungültig`);
      }
    };
    const name = header('x-file-name');
    if (!name) throw new HttpError(400, 'missing_name', 'Dateiname fehlt (x-file-name)');
    const subjectRaw = header('x-subject-id');
    const subjectId = subjectRaw && /^\d+$/.test(subjectRaw) ? Number(subjectRaw) : null;
    const batchId = header('x-batch-id');
    if (batchId && !/^[\w-]{1,64}$/.test(batchId)) throw new HttpError(400, 'invalid_batch', 'Ungültige Batch-ID');
    return s.ingest.importStream(req.body as Readable, { name, relPath: header('x-rel-path'), subjectId, batchId });
  });

  app.post(
    '/api/import/cancel',
    { schema: { body: { type: 'object', properties: { batchId: { type: 'string', pattern: '^[\\w-]{1,64}$' } }, required: ['batchId'] } } },
    async (req) => ({ cancelled: s.ingest.cancelBatch((req.body as { batchId: string }).batchId) }),
  );

  /* ------------------------------------------------------------ Suche */

  app.get(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { q: { type: 'string', maxLength: 500 }, scope: { type: 'string', maxLength: 20000 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
          required: ['q'],
        },
      },
    },
    async (req) => {
      const q = req.query as { q: string; scope?: string; limit?: number };
      return hybridSearch({ db: s.db, vectors: s.vectors, client: s.searchClient() }, q.q, {
        scope: parseScope(q.scope ?? '{"mode":"all"}'),
        limit: q.limit ?? 20,
      });
    },
  );

  /* ------------------------------------------------------------ Chats */

  app.get('/api/chats', { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 200 } } } } }, async (req) =>
    s.chat.list((req.query as { q?: string }).q),
  );

  const chatBody = {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 120 },
      model: { type: ['string', 'null'], maxLength: 200 },
      scope: {
        type: 'object',
        properties: { mode: { enum: ['all', 'subjects', 'sources', 'none'] }, ids: { type: 'array', items: { type: 'integer' }, maxItems: 5000 } },
        required: ['mode'],
      },
    },
    additionalProperties: false,
  } as const;

  app.post('/api/chats', { schema: { body: chatBody } }, async (req) => s.chat.create((req.body ?? {}) as { title?: string; scope?: unknown; model?: string | null }));

  app.get('/api/chats/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params as { id: number };
    return { session: s.chat.getSession(id), messages: s.chat.messages(id) };
  });

  app.patch('/api/chats/:id', { schema: { params: idParam, body: chatBody } }, async (req) => {
    const { id } = req.params as { id: number };
    return s.chat.update(id, req.body as { title?: string; scope?: unknown; model?: string | null });
  });

  app.delete('/api/chats/:id', { schema: { params: idParam } }, async (req) => {
    s.chat.delete((req.params as { id: number }).id);
    return { ok: true };
  });

  const streamAnswer = async (sessionId: number, input: { content?: string; regenerate?: boolean }, reply: FastifyReply) => {
    s.chat.getSession(sessionId); // 404 vor dem Öffnen des Streams
    const controller = new AbortController();
    const sse = openSse(reply);
    sse.onClose(() => controller.abort());
    try {
      await s.chat.respond(sessionId, input, sse, controller.signal);
    } catch (err) {
      const e = err as { code?: string; message: string };
      sse.send('error', { code: e.code ?? 'error', message: e.message });
    } finally {
      sse.close();
    }
  };

  app.post(
    '/api/chats/:id/messages',
    { schema: { params: idParam, body: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['content'] } } },
    async (req, reply) => streamAnswer((req.params as { id: number }).id, { content: (req.body as { content: string }).content }, reply),
  );

  app.post('/api/chats/:id/regenerate', { schema: { params: idParam } }, async (req, reply) =>
    streamAnswer((req.params as { id: number }).id, { regenerate: true }, reply),
  );
}
