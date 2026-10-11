import { streamPost } from '../api';
import type { ChatMessage, ChatSession, Citation, RetrievalInfo } from '../types';

export interface LiveStream {
  sessionId: number;
  userMessage: ChatMessage | null;
  assistant: ChatMessage;
  done: boolean;
  controller: AbortController;
}

/**
 * Laufende Antwort-Streams pro Chat. Ein Stream läuft weiter, wenn man den Chat wechselt,
 * und wird beim Zurückkehren wieder live angezeigt.
 */
class StreamRegistry {
  private streams = new Map<number, LiveStream>();
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = () => this.version;

  get(sessionId: number | null): LiveStream | null {
    return sessionId === null ? null : (this.streams.get(sessionId) ?? null);
  }

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private patch(sessionId: number, fn: (s: LiveStream) => LiveStream): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    this.streams.set(sessionId, fn(s));
    this.emit();
  }

  start(sessionId: number, body: { content?: string; regenerate?: boolean }, onFinished: (s: LiveStream) => void, onSession?: (s: ChatSession) => void): void {
    if (this.streams.get(sessionId)?.done === false) return;
    const controller = new AbortController();
    const now = Date.now();
    this.streams.set(sessionId, {
      sessionId,
      // optimistisch anzeigen, bis der Server die gespeicherte Nachricht liefert
      userMessage: body.content
        ? { id: -2, sessionId, role: 'user', content: body.content, thinking: null, citations: [], model: null, status: 'done', error: null, createdAt: now }
        : null,
      done: false,
      controller,
      assistant: {
        id: -1,
        sessionId,
        role: 'assistant',
        content: '',
        thinking: null,
        citations: [],
        model: null,
        status: 'streaming',
        error: null,
        createdAt: now,
        retrieval: null,
      },
    });
    this.emit();

    // Token-Updates pro Animationsframe bündeln (kein Re-Render pro Token)
    let pendingContent = '';
    let pendingThinking = '';
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (!pendingContent && !pendingThinking) return;
      const c = pendingContent;
      const th = pendingThinking;
      pendingContent = '';
      pendingThinking = '';
      this.patch(sessionId, (s) => ({
        ...s,
        assistant: { ...s.assistant, content: s.assistant.content + c, thinking: th ? (s.assistant.thinking ?? '') + th : s.assistant.thinking },
      }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const path = body.regenerate ? `/api/chats/${sessionId}/regenerate` : `/api/chats/${sessionId}/messages`;
    const payload = body.regenerate ? {} : { content: body.content };
    streamPost(
      path,
      payload,
      {
        onEvent: (event, data) => {
          const d = data as Record<string, unknown>;
          if (event === 'start') {
            this.patch(sessionId, (s) => ({ ...s, userMessage: d.userMessage as ChatMessage }));
            if (d.session && onSession) onSession(d.session as ChatSession);
          } else if (event === 'meta') {
            this.patch(sessionId, (s) => ({
              ...s,
              assistant: { ...s.assistant, id: d.assistantMessageId as number, citations: d.citations as Citation[], model: d.model as string, retrieval: d.retrieval as RetrievalInfo | null },
            }));
          } else if (event === 'token') {
            pendingContent += (d.delta as string) ?? '';
            schedule();
          } else if (event === 'thinking') {
            pendingThinking += (d.delta as string) ?? '';
            schedule();
          } else if (event === 'done') {
            flush();
            const final = d.message as ChatMessage;
            this.patch(sessionId, (s) => ({ ...s, done: true, assistant: { ...final, retrieval: s.assistant.retrieval } }));
          } else if (event === 'error') {
            flush();
            this.patch(sessionId, (s) => ({
              ...s,
              done: true,
              assistant: { ...s.assistant, status: 'error', error: { code: (d.code as string) ?? 'error', message: (d.message as string) ?? '' } },
            }));
          }
        },
      },
      controller.signal,
    )
      .catch((err: Error & { code?: string }) => {
        flush();
        const aborted = err.name === 'AbortError';
        this.patch(sessionId, (s) => ({
          ...s,
          done: true,
          assistant: { ...s.assistant, status: aborted ? 'aborted' : 'error', error: aborted ? null : { code: err.code ?? 'error', message: err.message } },
        }));
      })
      .finally(() => {
        flush();
        const s = this.streams.get(sessionId);
        if (s && !s.done) this.patch(sessionId, (x) => ({ ...x, done: true }));
        const final = this.streams.get(sessionId);
        if (final) onFinished(final);
      });
  }

  stop(sessionId: number): void {
    this.streams.get(sessionId)?.controller.abort();
  }

  clear(sessionId: number): void {
    if (this.streams.get(sessionId)?.done) {
      this.streams.delete(sessionId);
      this.emit();
    }
  }
}

export const streams = new StreamRegistry();
