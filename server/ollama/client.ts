/**
 * Schlanker Client für die lokale Ollama-HTTP-API (nur 127.0.0.1/localhost – siehe validateOllamaUrl).
 * Modelle werden NIE automatisch gepullt.
 */

export type OllamaErrorCode = 'unreachable' | 'model_missing' | 'timeout' | 'aborted' | 'oom' | 'http';

export class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  readonly status?: number;
  constructor(code: OllamaErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
  get transient(): boolean {
    return this.code === 'unreachable' || this.code === 'timeout' || (this.code === 'http' && (this.status ?? 0) >= 500);
  }
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

export interface RunningModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at?: string;
  context_length?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  think?: boolean;
  options?: Record<string, unknown>;
  keep_alive?: string;
}

export interface ChatDelta {
  content: string;
  thinking: string;
  done: boolean;
  evalCount?: number;
  evalDurationNs?: number;
}

function mapFetchError(err: unknown, signal?: AbortSignal): OllamaError {
  if (err instanceof OllamaError) return err;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  if (signal?.aborted || e.name === 'AbortError') {
    const reason = signal?.reason as { name?: string } | undefined;
    if (reason?.name === 'TimeoutError') return new OllamaError('timeout', 'Ollama antwortet nicht (Zeitüberschreitung)');
    return new OllamaError('aborted', 'abgebrochen');
  }
  if (e.name === 'TimeoutError') return new OllamaError('timeout', 'Ollama antwortet nicht (Zeitüberschreitung)');
  return new OllamaError('unreachable', `Ollama ist nicht erreichbar (${e.cause?.code ?? e.message ?? 'Verbindungsfehler'})`);
}

async function errorFromResponse(res: Response, model?: string): Promise<OllamaError> {
  let msg = '';
  try {
    const body = (await res.json()) as { error?: string };
    msg = body.error ?? '';
  } catch {
    /* kein JSON */
  }
  if (res.status === 404 || /not found|pull/i.test(msg)) {
    return new OllamaError('model_missing', `Modell "${model ?? '?'}" ist nicht installiert (ollama pull ${model ?? '<modell>'})`, res.status);
  }
  if (/memory|out of memory|cuda|vram/i.test(msg)) {
    return new OllamaError('oom', `Zu wenig Speicher für das Modell: ${msg}`, res.status);
  }
  return new OllamaError('http', msg || `Ollama-Fehler HTTP ${res.status}`, res.status);
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export class OllamaClient {
  private readonly getBaseUrl: () => string;
  private capabilityCache = new Map<string, { caps: string[]; at: number }>();

  constructor(getBaseUrl: () => string) {
    this.getBaseUrl = getBaseUrl;
  }

  get baseUrl(): string {
    return this.getBaseUrl();
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal; model?: string } = {}): Promise<T> {
    const signal = combineSignals(init.signal, init.timeoutMs ?? 10_000);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: init.body ? { 'content-type': 'application/json' } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal,
      });
    } catch (err) {
      throw mapFetchError(err, signal);
    }
    if (!res.ok) throw await errorFromResponse(res, init.model);
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw mapFetchError(err, signal);
    }
  }

  async version(): Promise<string> {
    const r = await this.request<{ version: string }>('/api/version', { timeoutMs: 3000 });
    return r.version;
  }

  async tags(): Promise<OllamaModel[]> {
    const r = await this.request<{ models?: OllamaModel[] }>('/api/tags', { timeoutMs: 5000 });
    return r.models ?? [];
  }

  async ps(): Promise<RunningModel[]> {
    const r = await this.request<{ models?: RunningModel[] }>('/api/ps', { timeoutMs: 5000 });
    return r.models ?? [];
  }

  async capabilities(model: string): Promise<string[]> {
    const cached = this.capabilityCache.get(model);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.caps;
    const r = await this.request<{ capabilities?: string[] }>('/api/show', { body: { model }, timeoutMs: 8000, model });
    const caps = r.capabilities ?? [];
    this.capabilityCache.set(model, { caps, at: Date.now() });
    return caps;
  }

  /** Batch-Embeddings via /api/embed mit Retry/Backoff für transiente Fehler. */
  async embed(model: string, input: string[], opts: { signal?: AbortSignal; retries?: number; timeoutMs?: number } = {}): Promise<Float32Array[]> {
    const retries = opts.retries ?? 2;
    let attempt = 0;
    for (;;) {
      try {
        const r = await this.request<{ embeddings?: number[][] }>('/api/embed', {
          body: { model, input, truncate: true },
          timeoutMs: opts.timeoutMs ?? 120_000,
          signal: opts.signal,
          model,
        });
        const embs = r.embeddings ?? [];
        if (embs.length !== input.length) throw new OllamaError('http', 'Ollama lieferte eine falsche Anzahl Embeddings');
        return embs.map((e) => Float32Array.from(e));
      } catch (err) {
        const e = err instanceof OllamaError ? err : mapFetchError(err, opts.signal);
        if (!e.transient || attempt >= retries || opts.signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        attempt++;
      }
    }
  }

  /** Streaming-Chat (NDJSON). */
  async *chatStream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatDelta> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...req, stream: true }),
        // Erstes Laden eines Modells kann dauern; danach kommen laufend Tokens.
        signal: combineSignals(signal, 15 * 60 * 1000),
      });
    } catch (err) {
      throw mapFetchError(err, signal);
    }
    if (!res.ok || !res.body) throw await errorFromResponse(res, req.model);
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const obj = JSON.parse(line) as {
            error?: string;
            done?: boolean;
            message?: { content?: string; thinking?: string };
            eval_count?: number;
            eval_duration?: number;
          };
          if (obj.error) {
            throw /memory|cuda|vram/i.test(obj.error) ? new OllamaError('oom', obj.error) : new OllamaError('http', obj.error);
          }
          yield {
            content: obj.message?.content ?? '',
            thinking: obj.message?.thinking ?? '',
            done: !!obj.done,
            evalCount: obj.eval_count,
            evalDurationNs: obj.eval_duration,
          };
        }
      }
    } catch (err) {
      throw mapFetchError(err, signal);
    }
  }

  /** Nicht-streamender, kurzer Chat-Aufruf (z. B. Auto-Titel). */
  async chatOnce(req: ChatRequest, timeoutMs: number): Promise<string> {
    const r = await this.request<{ message?: { content?: string } }>('/api/chat', {
      body: { ...req, stream: false },
      timeoutMs,
      model: req.model,
    });
    return r.message?.content ?? '';
  }
}
