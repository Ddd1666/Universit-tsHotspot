import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT, loadConfig, type AppConfig } from '../server/config.ts';
import { createHotspot, type Hotspot } from '../server/app.ts';

/** Testdaten bleiben im Projektordner (.tmp/), nichts außerhalb. */
export const TMP_ROOT = path.join(PROJECT_ROOT, '.tmp', 'tests');

export function tmpDir(prefix = 'case'): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));
}

export function writeTmp(dir: string, name: string, data: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeout?: number; interval?: number; message?: string } = {}): Promise<NonNullable<T>> {
  const end = Date.now() + (opts.timeout ?? 10_000);
  let last: T | undefined;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last as NonNullable<T>;
    await new Promise((r) => setTimeout(r, opts.interval ?? 50));
  }
  throw new Error(`waitFor Timeout: ${opts.message ?? ''} (letzter Wert: ${JSON.stringify(last)})`);
}

export interface TestApp {
  hotspot: Hotspot;
  url: string;
  port: number;
  token: string;
  dataDir: string;
  /** JSON-Request mit gültigem Token */
  api<T = unknown>(method: string, p: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; data: T; headers: Headers }>;
  upload(name: string, data: Buffer | string, opts?: { subjectId?: number; batchId?: string; relPath?: string }): Promise<{ status: number; data: { status: string; source: { id: number; status: string; kind: string } } }>;
  /** SSE-POST, gibt alle Events zurück */
  stream(p: string, body: unknown, opts?: { abortAfter?: (event: string) => boolean }): Promise<{ event: string; data: Record<string, unknown> }[]>;
  close(): Promise<void>;
}

export async function startTestApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const dataDir = overrides.dataDir ?? tmpDir('app');
  const token = crypto.randomBytes(32).toString('hex');
  const config = loadConfig({
    dataDir,
    port: 0,
    token,
    mockOllama: true,
    devOrigins: [],
    webDir: null,
    logToFile: false,
    extractInWorker: true,
    ...overrides,
  });
  const hotspot = await createHotspot(config);
  // Mock deterministisch schnell
  const { url, port } = await hotspot.listen();

  const api: TestApp['api'] = async (method, p, body, headers = {}) => {
    const res = await fetch(url + p, {
      method,
      headers: { 'x-hotspot-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* kein JSON */
    }
    return { status: res.status, data: data as never, headers: res.headers };
  };

  const upload: TestApp['upload'] = async (name, data, opts = {}) => {
    const headers: Record<string, string> = {
      'x-hotspot-token': token,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    };
    if (opts.subjectId) headers['x-subject-id'] = String(opts.subjectId);
    if (opts.batchId) headers['x-batch-id'] = opts.batchId;
    if (opts.relPath) headers['x-rel-path'] = encodeURIComponent(opts.relPath);
    const res = await fetch(url + '/api/import', { method: 'POST', headers, body: typeof data === 'string' ? data : new Uint8Array(data) });
    return { status: res.status, data: (await res.json()) as never };
  };

  const stream: TestApp['stream'] = async (p, body, opts = {}) => {
    const ctrl = new AbortController();
    const res = await fetch(url + p, {
      method: 'POST',
      headers: { 'x-hotspot-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const events: { event: string; data: Record<string, unknown> }[] = [];
    if (!res.ok) {
      events.push({ event: 'http-error', data: { status: res.status, ...((await res.json()) as object) } });
      return events;
    }
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(part, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
          const d = /^data: (.*)$/m.exec(block)?.[1];
          if (d) {
            events.push({ event: ev, data: JSON.parse(d) });
            if (opts.abortAfter?.(ev)) {
              ctrl.abort();
              return events;
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') throw err;
    }
    return events;
  };

  return {
    hotspot,
    url,
    port,
    token,
    dataDir,
    api,
    upload,
    stream,
    close: async () => {
      await hotspot.close();
    },
  };
}

/** Warten bis eine Quelle einen Endzustand erreicht. */
export async function waitForSource(app: TestApp, id: number, states = ['ready', 'error', 'unsupported', 'archive', 'cancelled']) {
  return waitFor(async () => {
    const r = await app.api<{ source: { status: string; statusDetail: string | null; chunkCount: number } }>('GET', `/api/sources/${id}`);
    return states.includes(r.data.source.status) ? r.data.source : null;
  }, { message: `source ${id}` });
}

export async function waitForEmbeddings(app: TestApp) {
  return waitFor(() => {
    const st = app.hotspot.services.embed.status();
    return st.pending === 0 && st.state === 'idle' ? st : null;
  }, { message: 'embeddings', timeout: 15_000 });
}
