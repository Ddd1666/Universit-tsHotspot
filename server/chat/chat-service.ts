import type { DB } from '../db.ts';
import type { EventBus } from '../events.ts';
import { HttpError } from '../library.ts';
import { OllamaError, type OllamaClient } from '../ollama/client.ts';
import type { SettingsStore } from '../settings.ts';
import { parseScope, type Scope, type SearchResult } from '../search/hybrid.ts';
import { buildPrompt, usedCitationNumbers, type Citation, type HistoryMessage } from './prompt.ts';
import { ThinkSplitter } from './think.ts';

export interface SessionDTO {
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

export interface MessageDTO {
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
}

export interface StreamSink {
  send(event: string, data: unknown): void;
}

interface SessionRow {
  id: number;
  title: string;
  title_locked: number;
  model: string | null;
  scope: string;
  created_at: number;
  updated_at: number;
  messageCount?: number;
}

interface MessageRow {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  thinking: string | null;
  citations: string | null;
  model: string | null;
  status: MessageDTO['status'];
  error: string | null;
  created_at: number;
}

const MODEL_RE = /^[\w.\-/:]{1,200}$/;

export function fallbackTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line || 'Neuer Chat';
  const cut = line.lastIndexOf(' ', 57);
  return line.slice(0, cut > 30 ? cut : 57) + '…';
}

export function cleanTitle(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/[*#_`"“”„]/g, '')
    .replace(/^\s*(title|titel)\s*:\s*/i, '')
    .replace(/[.:;,!]+$/, '')
    .trim()
    .slice(0, 80) ?? '';
}

function toSession(r: SessionRow): SessionDTO {
  return {
    id: r.id,
    title: r.title,
    titleLocked: !!r.title_locked,
    model: r.model,
    scope: parseScope(r.scope),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: r.messageCount ?? 0,
  };
}

function toMessage(r: MessageRow): MessageDTO {
  let citations: Citation[];
  let error: MessageDTO['error'];
  try {
    citations = r.citations ? (JSON.parse(r.citations) as Citation[]) : [];
  } catch {
    citations = [];
  }
  try {
    error = r.error ? (JSON.parse(r.error) as MessageDTO['error']) : null;
  } catch {
    error = { code: 'error', message: r.error ?? '' };
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    thinking: r.thinking,
    citations,
    model: r.model,
    status: r.status,
    error,
    createdAt: r.created_at,
  };
}

export type SearchFn = (query: string, scope: Scope, limit: number, signal: AbortSignal) => Promise<SearchResult>;

/** Chat-Sessions: jede Session ist ein eigener, persistenter Chat mit eigenem Wissensbereich und Modell. */
export class ChatService {
  private readonly deps: { db: DB; settings: SettingsStore; client: OllamaClient; search: SearchFn; bus: EventBus; log: (m: string, e?: unknown) => void };
  private titleJobs = new Set<Promise<void>>();

  constructor(deps: ChatService['deps']) {
    this.deps = deps;
  }

  /** Nach Absturz/Neustart: halbfertige Antworten als abgebrochen markieren. */
  recoverInterrupted(): void {
    this.deps.db.prepare("UPDATE chat_messages SET status = 'aborted' WHERE status = 'streaming'").run();
  }

  private row(id: number): SessionRow {
    const r = this.deps.db
      .prepare('SELECT s.*, (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount FROM chat_sessions s WHERE s.id = ?')
      .get(id) as SessionRow | undefined;
    if (!r) throw new HttpError(404, 'not_found', 'Chat nicht gefunden');
    return r;
  }

  getSession(id: number): SessionDTO {
    return toSession(this.row(id));
  }

  list(q?: string): SessionDTO[] {
    const { db } = this.deps;
    if (!q || !q.trim()) {
      return (db
        .prepare('SELECT s.*, (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount FROM chat_sessions s ORDER BY s.updated_at DESC LIMIT 1000')
        .all() as unknown as SessionRow[]).map(toSession);
    }
    const like = `%${q.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const rows = db
      .prepare(
        `SELECT s.*, (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id) AS messageCount,
           (SELECT m.content FROM chat_messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\' ORDER BY m.id LIMIT 1) AS matchText
         FROM chat_sessions s
         WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.content LIKE ? ESCAPE '\\')
         ORDER BY s.updated_at DESC LIMIT 200`,
      )
      .all(like, like, like) as unknown as (SessionRow & { matchText: string | null })[];
    const needle = q.trim().toLowerCase();
    return rows.map((r) => {
      const dto = toSession(r);
      if (r.matchText) {
        const pos = r.matchText.toLowerCase().indexOf(needle);
        const start = Math.max(0, pos - 40);
        dto.match = (start > 0 ? '…' : '') + r.matchText.slice(start, start + 120).replace(/\s+/g, ' ');
      }
      return dto;
    });
  }

  create(input: { title?: string; scope?: unknown; model?: string | null } = {}): SessionDTO {
    const now = Date.now();
    const title = (input.title ?? '').trim().slice(0, 120);
    const model = input.model && MODEL_RE.test(input.model) ? input.model : null;
    const r = this.deps.db
      .prepare('INSERT INTO chat_sessions(title, title_locked, model, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title || 'Neuer Chat', title ? 1 : 0, model, JSON.stringify(parseScope(input.scope ?? { mode: 'all' })), now, now);
    const s = this.getSession(Number(r.lastInsertRowid));
    this.deps.bus.emit({ type: 'chat', session: s });
    return s;
  }

  update(id: number, patch: { title?: string; scope?: unknown; model?: string | null }): SessionDTO {
    const { db } = this.deps;
    this.row(id);
    if (patch.title !== undefined) {
      const t = patch.title.trim().slice(0, 120);
      if (!t) throw new HttpError(400, 'invalid_title', 'Titel fehlt');
      db.prepare('UPDATE chat_sessions SET title = ?, title_locked = 1 WHERE id = ?').run(t, id);
    }
    if (patch.scope !== undefined) db.prepare('UPDATE chat_sessions SET scope = ? WHERE id = ?').run(JSON.stringify(parseScope(patch.scope)), id);
    if (patch.model !== undefined) {
      if (patch.model !== null && !MODEL_RE.test(patch.model)) throw new HttpError(400, 'invalid_model', 'Ungültiger Modellname');
      db.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(patch.model, id);
    }
    const s = this.getSession(id);
    this.deps.bus.emit({ type: 'chat', session: s });
    return s;
  }

  delete(id: number): void {
    this.row(id);
    this.deps.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id); // Nachrichten per FK-Cascade
    this.deps.bus.emit({ type: 'chat-deleted', id });
  }

  messages(sessionId: number): MessageDTO[] {
    this.row(sessionId);
    return (this.deps.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id').all(sessionId) as unknown as MessageRow[]).map(toMessage);
  }

  private message(id: number): MessageDTO {
    return toMessage(this.deps.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as unknown as MessageRow);
  }

  /** Wartet auf laufende Auto-Titel (Tests / sauberes Beenden). */
  async idle(): Promise<void> {
    await Promise.all([...this.titleJobs]);
  }

  /**
   * Frage beantworten (oder letzte Antwort neu generieren) – streamt Ereignisse an `sink`:
   * start, meta (Quellen), thinking, token, done | error.
   */
  async respond(sessionId: number, input: { content?: string; regenerate?: boolean }, sink: StreamSink, signal: AbortSignal): Promise<void> {
    const { db, settings, client, search, bus } = this.deps;
    const session = this.row(sessionId);
    const s = settings.get();
    const now = Date.now();
    let question: string;
    let userMsgId: number;
    if (input.regenerate) {
      const last = db.prepare("SELECT id, content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(sessionId) as
        | { id: number; content: string }
        | undefined;
      if (!last) throw new HttpError(409, 'nothing_to_regenerate', 'Keine Frage zum Neu-Generieren');
      db.prepare('DELETE FROM chat_messages WHERE session_id = ? AND id > ?').run(sessionId, last.id);
      question = last.content;
      userMsgId = last.id;
    } else {
      question = (input.content ?? '').trim();
      if (!question) throw new HttpError(400, 'empty', 'Nachricht ist leer');
      if (question.length > 20000) throw new HttpError(400, 'too_long', 'Nachricht ist zu lang (max. 20 000 Zeichen)');
      userMsgId = Number(
        db.prepare("INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'user', ?, 'done', ?)").run(sessionId, question, now).lastInsertRowid,
      );
      if (!session.title_locked && (session.messageCount ?? 0) === 0) {
        db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(fallbackTitle(question), sessionId);
      }
    }
    db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    sink.send('start', { userMessage: this.message(userMsgId), session: this.getSession(sessionId) });

    const history = (db
      .prepare("SELECT role, content FROM chat_messages WHERE session_id = ? AND id < ? AND content != '' AND status IN ('done', 'aborted') ORDER BY id")
      .all(sessionId, userMsgId) as unknown as HistoryMessage[]);
    const model = session.model ?? s.chatModel;
    const scope = parseScope(session.scope);

    // --- Retrieval
    let retrieval: { mode: string; tookMs: number; vectorError: string | null; hits: number } | null = null;
    let hits = null;
    if (scope.mode !== 'none') {
      const prevUser = [...history].reverse().find((m) => m.role === 'user');
      const query = question.length < 40 && prevUser ? `${prevUser.content.slice(0, 300)} ${question}` : question;
      try {
        const r = await search(query, scope, s.retrievalTopK, signal);
        hits = r.hits;
        retrieval = { mode: r.mode, tookMs: r.tookMs, vectorError: r.vectorError, hits: r.hits.length };
      } catch (err) {
        hits = [];
        retrieval = { mode: 'error', tookMs: 0, vectorError: (err as Error).message, hits: 0 };
      }
    }
    const prompt = buildPrompt({ history, question, hits, numCtx: s.numCtx });
    const assistantId = Number(
      db
        .prepare("INSERT INTO chat_messages(session_id, role, content, citations, model, status, created_at) VALUES (?, 'assistant', '', ?, ?, 'streaming', ?)")
        .run(sessionId, JSON.stringify(prompt.citations), model, Date.now()).lastInsertRowid,
    );
    sink.send('meta', { assistantMessageId: assistantId, citations: prompt.citations, retrieval, budget: prompt.budget, model });

    let content = '';
    let thinking = '';
    const splitter = new ThinkSplitter();
    const finish = (status: MessageDTO['status'], error: MessageDTO['error']) => {
      const used = usedCitationNumbers(content);
      const citations = prompt.citations.map((c) => ({ ...c, used: used.has(c.n) }));
      db.prepare('UPDATE chat_messages SET content = ?, thinking = ?, citations = ?, status = ?, error = ? WHERE id = ?').run(
        content,
        thinking || null,
        JSON.stringify(citations),
        status,
        error ? JSON.stringify(error) : null,
        assistantId,
      );
      db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
      return this.message(assistantId);
    };

    try {
      let think: boolean | undefined;
      try {
        const caps = await client.capabilities(model);
        if (caps.includes('thinking')) think = s.thinking;
      } catch (err) {
        if (err instanceof OllamaError && (err.code === 'unreachable' || err.code === 'model_missing')) throw err;
      }
      for await (const d of client.chatStream(
        { model, messages: prompt.messages, think, options: { num_ctx: s.numCtx, temperature: s.temperature } },
        signal,
      )) {
        if (d.thinking) {
          thinking += d.thinking;
          sink.send('thinking', { delta: d.thinking });
        }
        if (d.content) {
          const r = splitter.push(d.content);
          if (r.thinking) {
            thinking += r.thinking;
            sink.send('thinking', { delta: r.thinking });
          }
          if (r.content) {
            content += r.content;
            sink.send('token', { delta: r.content });
          }
        }
      }
      const rest = splitter.flush();
      if (rest.thinking) thinking += rest.thinking;
      if (rest.content) {
        content += rest.content;
        sink.send('token', { delta: rest.content });
      }
      content = content.replace(/^\s+/, '');
      const msg = finish('done', null);
      sink.send('done', { message: msg });
      if (!session.title_locked && !input.regenerate && (session.messageCount ?? 0) === 0) this.autoTitle(sessionId, question, content, model);
    } catch (err) {
      if (signal.aborted) {
        finish('aborted', null);
      } else {
        const e = err instanceof OllamaError ? err : new OllamaError('http', (err as Error).message);
        const msg = finish('error', { code: e.code, message: e.message });
        sink.send('error', { code: e.code, message: e.message, message_id: msg.id });
        this.deps.log('Chat-Fehler', e.message);
      }
    } finally {
      bus.emit({ type: 'chat', session: this.safeSession(sessionId) });
    }
  }

  private safeSession(id: number): SessionDTO | null {
    try {
      return this.getSession(id);
    } catch {
      return null;
    }
  }

  /** Auto-Titel nach erster Antwort: kurzer LLM-Call im Hintergrund, Fallback = erste Frage (bereits gesetzt). */
  private autoTitle(sessionId: number, question: string, answer: string, model: string): void {
    const { client, db, bus } = this.deps;
    const job = (async () => {
      try {
        let think: boolean | undefined;
        try {
          if ((await client.capabilities(model)).includes('thinking')) think = false;
        } catch {
          /* ignorieren */
        }
        const raw = await client.chatOnce(
          {
            model,
            think,
            messages: [
              {
                role: 'system',
                content: 'You write a very short title (max 6 words) for a conversation. Use the language of the question. Reply with the title only, without quotes.',
              },
              { role: 'user', content: `Question: ${question.slice(0, 500)}\nAnswer: ${answer.slice(0, 500)}\n\nTitle:` },
            ],
            options: { num_ctx: 2048, num_predict: 24, temperature: 0.2 },
          },
          30_000,
        );
        const title = cleanTitle(raw);
        if (!title) return;
        const r = db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ? AND title_locked = 0').run(title, sessionId);
        if (Number(r.changes) > 0) bus.emit({ type: 'chat', session: this.safeSession(sessionId) });
      } catch {
        /* Fallback-Titel bleibt */
      }
    })();
    this.titleJobs.add(job);
    void job.finally(() => this.titleJobs.delete(job));
  }
}
