/* Spiegel der Server-DTOs (bewusst ohne Code-Sharing, damit das Frontend unabhängig baubar bleibt). */

export interface Settings {
  language: 'de' | 'en';
  theme: 'dark' | 'light';
  accent: 'cyan' | 'violet' | 'lime';
  motion: 'system' | 'reduced';
  ollamaUrl: string;
  chatModel: string;
  embeddingModel: string;
  numCtx: number;
  temperature: number;
  thinking: boolean;
  retrievalTopK: number;
  maxFileSizeMB: number;
  zipMaxEntries: number;
  zipMaxTotalMB: number;
  ingestConcurrency: number;
  embedBatchSize: number;
}

export interface Subject {
  id: number;
  name: string;
  color: string;
  createdAt: number;
  sourceCount: number;
}

export interface Source {
  id: number;
  subjectId: number | null;
  parentId: number | null;
  name: string;
  relPath: string | null;
  size: number;
  mime: string;
  kind: string;
  status: 'queued' | 'processing' | 'ready' | 'error' | 'unsupported' | 'cancelled' | 'archive';
  statusDetail: string | null;
  pageCount: number | null;
  chunkCount: number;
  embeddedCount: number;
  childCount: number;
  batchId: string | null;
  sha256: string;
  importedAt: number;
  processedAt: number | null;
}

export interface ChunkPreview {
  id: number;
  ord: number;
  text: string;
  heading: string | null;
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  embedState: number;
}

export interface OllamaStatus {
  reachable: boolean;
  url: string;
  mock: boolean;
  version: string | null;
  models: { name: string; size: number; family: string | null; parameterSize: string | null; quantization: string | null }[];
  running: { name: string; size: number; sizeVram: number; gpuPercent: number; contextLength: number | null; expiresAt: string | null }[];
  error: string | null;
  checkedAt: number;
}

export interface EmbedStatus {
  state: 'idle' | 'running' | 'waiting_ollama' | 'model_missing' | 'error';
  pending: number;
  done: number;
  failed: number;
  indexModel: string | null;
  indexDim: number | null;
  settingsModel: string;
  reindexNeeded: boolean;
  lastError: string | null;
  retryAt: number | null;
}

export interface QueueStatus {
  ingest: { queued: number; processing: { id: number; name: string }[] };
  embed: EmbedStatus;
}

export interface Stats {
  subjects: number;
  sources: number;
  chunks: number;
  vectors: number;
  bytes: number;
}

export interface Bootstrap {
  version: string;
  mock: boolean;
  dataDir: string;
  platform: string;
  settings: Settings;
  defaults: Settings;
  subjects: Subject[];
  ollama: OllamaStatus;
  queue: QueueStatus;
  stats: Stats;
  vectorStore: string;
}

export type Scope = { mode: 'all' } | { mode: 'subjects'; ids: number[] } | { mode: 'sources'; ids: number[] } | { mode: 'none' };

export interface ChatSession {
  id: number;
  title: string;
  titleLocked: boolean;
  model: string | null;
  scope: Scope;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  match?: string;
}

export interface Citation {
  n: number;
  chunkId: number;
  sourceId: number;
  sourceName: string;
  subjectName: string | null;
  subjectColor: string | null;
  heading: string | null;
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  snippet: string;
  used?: boolean;
}

export interface ChatMessage {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  citations: Citation[];
  model: string | null;
  status: 'done' | 'streaming' | 'aborted' | 'error';
  error: { code: string; message: string } | null;
  createdAt: number;
  /** nur clientseitig */
  retrieval?: RetrievalInfo | null;
}

export interface RetrievalInfo {
  mode: string;
  tookMs: number;
  vectorError: string | null;
  hits: number;
}

export interface SearchHit {
  chunkId: number;
  sourceId: number;
  sourceName: string;
  subjectId: number | null;
  subjectName: string | null;
  subjectColor: string | null;
  text: string;
  heading: string | null;
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  snippet: string;
  score: number;
  matchedBy: ('fts' | 'vector')[];
}

export interface SearchResult {
  hits: SearchHit[];
  mode: 'hybrid' | 'fts' | 'vector' | 'empty';
  tookMs: number;
  vectorError: string | null;
}

export type HubEvent =
  | { type: 'source'; source: Source }
  | { type: 'source-deleted'; id: number }
  | { type: 'subjects' }
  | { type: 'queue'; ingest: QueueStatus['ingest']; embed: EmbedStatus }
  | { type: 'ollama'; status: OllamaStatus }
  | { type: 'chat'; session: ChatSession | null }
  | { type: 'chat-deleted'; id: number }
  | { type: 'settings'; settings: Settings };
