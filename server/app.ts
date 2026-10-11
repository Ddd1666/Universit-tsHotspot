import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.ts';
import { openDb, type DB } from './db.ts';
import { EventBus } from './events.ts';
import { SettingsStore } from './settings.ts';
import { BlobStore } from './storage.ts';
import { Library } from './library.ts';
import { SqliteVectorStore } from './embed/vector-store.ts';
import { EmbedQueue, type EmbedStatus } from './embed/embed-queue.ts';
import { ExtractionPool } from './ingest/worker-pool.ts';
import { IngestService, type IngestStats } from './ingest/ingest.ts';
import { OllamaClient } from './ollama/client.ts';
import { OllamaMonitor } from './ollama/status.ts';
import { startMockOllama, type MockOllama } from './ollama/mock.ts';
import { ChatService } from './chat/chat-service.ts';
import { hybridSearch } from './search/hybrid.ts';
import { registerSecurity } from './http/security.ts';
import { registerRoutes } from './http/routes.ts';
import { registerWeb } from './http/web.ts';

export interface Services {
  config: AppConfig;
  db: DB;
  settings: SettingsStore;
  bus: EventBus;
  blobs: BlobStore;
  library: Library;
  vectors: SqliteVectorStore;
  embed: EmbedQueue;
  ingest: IngestService;
  client: OllamaClient;
  monitor: OllamaMonitor;
  chat: ChatService;
  queueStatus(): { ingest: IngestStats; embed: EmbedStatus };
  notifyQueue(): void;
  /** Ollama-Client für Suche – null, wenn Ollama bekanntermaßen offline ist (dann reine Volltextsuche). */
  searchClient(): OllamaClient | null;
}

export interface Hotspot {
  app: FastifyInstance;
  services: Services;
  mock: MockOllama | null;
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

function rotateLog(file: string): void {
  try {
    if (fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {
    /* existiert nicht */
  }
}

export async function createHotspot(config: AppConfig): Promise<Hotspot> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const logDir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'server.log');
  rotateLog(logFile);

  const db = openDb(path.join(config.dataDir, 'hotspot.sqlite'));
  const settings = new SettingsStore(db);
  const bus = new EventBus();
  const blobs = new BlobStore(config.dataDir);
  blobs.init();

  const mock = config.mockOllama ? await startMockOllama() : null;
  const client = new OllamaClient(() => config.ollamaUrlOverride ?? mock?.url ?? settings.get().ollamaUrl);
  const vectors = new SqliteVectorStore(db);
  const library = new Library(db, blobs, vectors, bus);
  const pool = new ExtractionPool({ inWorker: config.extractInWorker });

  const app = Fastify({
    logger: config.logToFile ? { level: config.logLevel, file: logFile } : false,
    bodyLimit: 1024 * 1024,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
  });
  const log = (msg: string, extra?: unknown) => app.log.info({ extra }, msg);

  let queueTimer: NodeJS.Timeout | null = null;
  const services = {} as Services;
  const notifyQueue = () => {
    if (queueTimer) return;
    queueTimer = setTimeout(() => {
      queueTimer = null;
      bus.emit({ type: 'queue', ...services.queueStatus() });
    }, 250);
  };

  const embed = new EmbedQueue({ db, store: vectors, client, settings, bus, onProgress: notifyQueue });
  const ingest = new IngestService({
    db,
    blobs,
    pool,
    settings,
    bus,
    library,
    onChunksStored: () => embed.notify(),
    onQueueChange: notifyQueue,
    log,
  });
  const monitor = new OllamaMonitor(client, !!mock, (status, cameOnline) => {
    bus.emit({ type: 'ollama', status });
    if (cameOnline) embed.notify();
  });
  const searchClient = () => (monitor.status.reachable || monitor.status.checkedAt === 0 ? client : null);
  const chat = new ChatService({
    db,
    settings,
    client,
    bus,
    log,
    search: (q, scope, limit, signal) => hybridSearch({ db, vectors, client: searchClient() }, q, { scope, limit, signal }),
  });
  chat.recoverInterrupted();

  settings.onChange((_s, changed) => {
    if (changed.includes('ollamaUrl')) void monitor.refresh();
    if (changed.includes('embeddingModel')) notifyQueue();
  });

  Object.assign(services, {
    config,
    db,
    settings,
    bus,
    blobs,
    library,
    vectors,
    embed,
    ingest,
    client,
    monitor,
    chat,
    queueStatus: () => ({ ingest: ingest.stats(), embed: embed.status() }),
    notifyQueue,
    searchClient,
  } satisfies Services);

  let port = config.port;
  registerSecurity(app, { token: config.token, getPort: () => port, devOrigins: config.devOrigins });
  registerRoutes(app, services);
  registerWeb(app, config.webDir, config.token);

  let closed = false;
  let maintenanceTimer: NodeJS.Timeout | null = null;
  return {
    app,
    services,
    mock,
    async listen() {
      // Nur Loopback – nie 0.0.0.0
      await app.listen({ host: '127.0.0.1', port: config.port });
      const addr = app.server.address();
      port = typeof addr === 'object' && addr ? addr.port : config.port;
      monitor.start();
      ingest.start();
      embed.start();
      maintenanceTimer = setTimeout(() => {
        if (closed) return;
        vectors.warmup();
        void library
          .gcOrphanBlobs()
          .then((n) => n && log(`${n} verwaiste Datei(en) entfernt`))
          .catch(() => {});
      }, 1500);
      maintenanceTimer.unref();
      return { url: `http://127.0.0.1:${port}`, port };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (maintenanceTimer) clearTimeout(maintenanceTimer);
      monitor.stop();
      if (queueTimer) clearTimeout(queueTimer);
      await ingest.stop();
      await embed.stop();
      await pool.close();
      await chat.idle();
      await app.close();
      await mock?.close();
      db.close();
    },
  };
}
