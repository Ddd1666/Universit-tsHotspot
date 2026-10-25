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
  visionModel: string;
  mediaImages: boolean;
  mediaAudio: boolean;
  mediaVideo: boolean;
  mediaScanOcr: boolean;
  mediaKeyframes: boolean;
  mediaEmbeddedImages: boolean;
  mediaLanguage: 'auto' | 'de' | 'en';
  whisperModel: string;
  mediaMaxDurationMin: number;
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
  status: 'queued' | 'processing' | 'media' | 'ready' | 'error' | 'unsupported' | 'cancelled' | 'archive';
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
  /** KI-generiert: 'ocr' | 'vision' | 'transcript' */
  origin: string | null;
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

export interface JobCounts {
  queued: number;
  running: number;
  error: number;
}

export interface QueueStatus {
  ingest: { queued: number; processing: { id: number; name: string }[] };
  embed: EmbedStatus;
  media: JobCounts;
  learn: JobCounts;
}

export interface MediaJob {
  id: number;
  sourceId: number;
  sourceName: string;
  kind: 'image' | 'scan' | 'audio' | 'video';
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  total: number | null;
  detail: string | null;
  note: 'waiting_ollama' | 'waiting_chat' | null;
  etaSec: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface MediaSetupState {
  running: boolean;
  queue: string[];
  current: string | null;
  received: number;
  total: number;
  done: string[];
  error: { id: string; code: string } | null;
}

export interface MediaStatus {
  tools: { ffmpeg: boolean; whisper: boolean; models: string[] };
  supported: boolean;
  platform: string;
  toolsDir: string;
  items: { id: string; label: string; size: number; url: string; installed: boolean }[];
  setup: MediaSetupState;
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
  origin?: string | null;
  sourceKind?: string;
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
  origin?: string | null;
  sourceKind?: string;
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
  | { type: 'queue'; ingest: QueueStatus['ingest']; embed: EmbedStatus; media: JobCounts; learn: JobCounts }
  | { type: 'job'; job: MediaJob }
  | { type: 'jobs'; counts: JobCounts }
  | { type: 'media-setup'; setup: MediaSetupState }
  | { type: 'ollama'; status: OllamaStatus }
  | { type: 'chat'; session: ChatSession | null }
  | { type: 'chat-deleted'; id: number }
  | { type: 'settings'; settings: Settings }
  | { type: 'learn-job'; job: LearnJob }
  | { type: 'learn-jobs'; counts: JobCounts };

/* ------------------------------------------------------------------ Phase 3: Lernmodi */

export interface Loc {
  k: string | null;
  s: number | null;
  e: number | null;
  l: string | null;
}

export interface LearnRef {
  n: number;
  chunkId: number | null;
  sourceId: number | null;
  sourceName: string;
  loc: Loc | null;
  heading: string | null;
  chatId?: number;
  deleted?: boolean;
}

export type LearnScope = { kind: 'source'; id: number; heading?: string | null } | { kind: 'sources'; ids: number[] } | { kind: 'subject'; id: number } | { kind: 'chat'; id: number };
export type LearnKind = 'summary' | 'cards' | 'quiz' | 'graph';
export type Level = 'tldr' | 'outline' | 'detailed' | 'cheatsheet';

export interface LearnJob {
  id: number;
  kind: LearnKind;
  state: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  title: string;
  params: { scope: LearnScope; level?: Level; count?: number };
  progress: number;
  total: number | null;
  detail: string | null;
  result: Record<string, number> | null;
  note: 'waiting_ollama' | 'waiting_chat' | null;
  etaSec: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NoteSummary {
  id: number;
  title: string;
  level: Level | null;
  subjectId: number | null;
  ai: boolean;
  edited: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  body: string;
  scope: { truncated?: boolean };
  citations: LearnRef[];
}

export type CardType = 'qa' | 'cloze' | 'image';
export type CardStatus = 'draft' | 'active' | 'suspended';

export interface Card {
  id: number;
  type: CardType;
  front: string;
  back: string;
  status: CardStatus;
  ai: boolean;
  subjectId: number | null;
  sourceId: number | null;
  sourceName: string | null;
  sourceKind: string | null;
  sourceDeleted: boolean;
  chunkId: number | null;
  loc: Loc | null;
  chat: { id: number; title: string } | null;
  reps: number;
  ease: number;
  intervalDays: number;
  lapses: number;
  due: number | null;
  lastReview: number | null;
  reviewCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SrsStats {
  heatmap: { day: string; n: number; ok: number }[];
  forecast: { day: string; n: number }[];
  retention: { total: number; ok: number; rate: number | null };
  counts: { active: number; draft: number; suspended: number; fresh: number; due: number };
}

export interface QuizQuestion {
  id: number;
  type: 'mc' | 'tf' | 'cloze' | 'short';
  question: string;
  options: string[] | null;
  topic: string | null;
  sourceName: string | null;
}

export interface QuizResult {
  score: number;
  answer: string;
  explanation: string | null;
  source: LearnRef;
  feedback: { score: number; rubric: { criterion: string; met: boolean }[]; reasoning: string; quotes: { doc: number; text: string }[]; refs: LearnRef[] } | null;
}

export interface Weakness {
  topic: string | null;
  sourceId: number | null;
  sourceName: string | null;
  chunkId: number | null;
  attempts: number;
  avg: number;
  cards: number;
}

export interface GraphNode {
  id: number;
  name: string;
  hidden: boolean;
  sources: number;
  degree: number;
}

export interface GraphEdge {
  id: number;
  a: number;
  b: number;
  label: string;
  hidden: boolean;
}

export interface ConceptDetail {
  id: number;
  name: string;
  description: string | null;
  hidden: boolean;
  edited: boolean;
  sources: { sourceId: number; sourceName: string; subjectId: number | null; chunkId: number | null; snippet: string | null; loc: Loc | null }[];
  neighbors: { edgeId: number; label: string; hidden: boolean; id: number; name: string }[];
}
