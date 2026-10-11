import type { HubEvent } from './types';

/** Zugriffstoken: vom Server in index.html eingesetzt (fremde Seiten können es nicht lesen). */
const TOKEN = document.querySelector<HTMLMetaElement>('meta[name="hotspot-token"]')?.content ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function handleAuthFailure(): void {
  // Server wurde neu gestartet -> neues Token: einmalig neu laden
  try {
    if (sessionStorage.getItem('hotspot-reloaded') !== '1') {
      sessionStorage.setItem('hotspot-reloaded', '1');
      location.reload();
    }
  } catch {
    /* Storage blockiert */
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { 'x-hotspot-token': TOKEN, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'Server nicht erreichbar');
  }
  if (res.status === 401) handleAuthFailure();
  else {
    try {
      sessionStorage.removeItem('hotspot-reloaded');
    } catch {
      /* ignore */
    }
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = { error: 'invalid_response', message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** URL zum Öffnen/Herunterladen einer Originaldatei (Token als Query, da <a href> keine Header setzen kann). */
export function fileUrl(sourceId: number, download = false): string {
  return `/api/sources/${sourceId}/file?t=${encodeURIComponent(TOKEN)}${download ? '&download=1' : ''}`;
}

/* ------------------------------------------------------------------ Server-Events (SSE) */

type Listener = (e: HubEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connListeners = new Set<(connected: boolean) => void>();

export function connectEvents(): void {
  if (source) return;
  source = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  const types: HubEvent['type'][] = ['source', 'source-deleted', 'subjects', 'queue', 'ollama', 'chat', 'chat-deleted', 'settings'];
  for (const type of types) {
    source.addEventListener(type, (ev) => {
      const data = JSON.parse((ev as MessageEvent<string>).data) as HubEvent;
      for (const l of listeners) l(data);
    });
  }
  source.addEventListener('hello', () => connListeners.forEach((l) => l(true)));
  source.onerror = () => {
    connListeners.forEach((l) => l(false));
    // Server neu gestartet? Dann ist das Token ungültig -> Seite neu laden
    void fetch('/api/health', { headers: { 'x-hotspot-token': TOKEN } })
      .then((r) => r.status === 401 && handleAuthFailure())
      .catch(() => {});
  };
}

export function onHubEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function onConnection(l: (connected: boolean) => void): () => void {
  connListeners.add(l);
  return () => {
    connListeners = new Set([...connListeners].filter((x) => x !== l));
  };
}

/* ------------------------------------------------------------------ Chat-Streaming (SSE über fetch/POST) */

export interface StreamHandlers {
  onEvent(event: string, data: unknown): void;
}

export async function streamPost(path: string, body: unknown, handlers: StreamHandlers, signal: AbortSignal): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-hotspot-token': TOKEN, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    let code = 'error';
    try {
      const d = (await res.json()) as { error?: string; message?: string };
      msg = d.message ?? msg;
      code = d.error ?? code;
    } catch {
      /* ignore */
    }
    if (res.status === 401) handleAuthFailure();
    throw new ApiError(res.status, code, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (data) handlers.onEvent(event, JSON.parse(data));
    }
  }
}

/* ------------------------------------------------------------------ Upload (XHR wegen Fortschrittsanzeige) */

export interface UploadHandle {
  promise: Promise<{ status: 'created' | 'duplicate'; source: import('./types').Source }>;
  abort(): void;
}

export function uploadFile(
  file: File,
  meta: { relPath?: string | null; subjectId?: number | null; batchId: string },
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ status: 'created' | 'duplicate'; source: import('./types').Source }>((resolve, reject) => {
    xhr.open('POST', '/api/import');
    xhr.setRequestHeader('x-hotspot-token', TOKEN);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-batch-id', meta.batchId);
    if (meta.relPath) xhr.setRequestHeader('x-rel-path', encodeURIComponent(meta.relPath));
    if (meta.subjectId) xhr.setRequestHeader('x-subject-id', String(meta.subjectId));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string; message?: string } & Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as never);
      else reject(new ApiError(xhr.status, data.error ?? 'error', data.message ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Upload fehlgeschlagen'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'abgebrochen'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
