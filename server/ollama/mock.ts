import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Mock-Ollama für Tests und den Browser-Testbetrieb ohne echtes Modell (HOTSPOT_MOCK_OLLAMA=1).
 * Deterministische Fake-Embeddings (Feature-Hashing -> ähnliche Wörter = ähnliche Vektoren)
 * und gestreamte Fake-Antworten, die Quellen [n] zitieren. NICHT für den echten Betrieb.
 */

export interface MockOllama {
  url: string;
  close(): Promise<void>;
  requests: { path: string; body: unknown }[];
  /** simuliert Ausfall (Verbindungen werden sofort geschlossen) */
  setDown(down: boolean): void;
}

const MODELS: { name: string; size: number; family: string; params: string; caps: string[] }[] = [
  { name: 'gemma3:4b', size: 3_338_801_804, family: 'gemma3', params: '4.3B', caps: ['completion', 'vision'] },
  { name: 'qwen3:4b', size: 2_620_788_019, family: 'qwen3', params: '4.0B', caps: ['completion', 'tools', 'thinking'] },
  { name: 'qwen3:8b', size: 5_225_376_047, family: 'qwen3', params: '8.2B', caps: ['completion', 'tools', 'thinking'] },
  { name: 'llama3.1:8b', size: 4_920_753_328, family: 'llama', params: '8.0B', caps: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', size: 274_302_450, family: 'nomic-bert', params: '137M', caps: ['embedding'] },
];

function findModel(name: string) {
  const n = name.includes(':') ? name : `${name}:latest`;
  return MODELS.find((m) => m.name === n || m.name === name);
}

export function embedDim(model: string): number {
  if (model.startsWith('nomic-embed-text')) return 768;
  if (model.startsWith('bge-m3')) return 1024;
  return 384;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministisches Fake-Embedding: Wort- und Wortstamm-Hashing, L2-normalisiert. */
export function fakeEmbedding(text: string, dim: number): number[] {
  const v = new Float32Array(dim);
  const clean = text.replace(/^(search_query|search_document):\s*/i, '').toLowerCase();
  const tokens = clean.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  for (const tok of tokens) {
    const h1 = hash32(tok);
    v[h1 % dim]! += h1 & 1 ? 1 : -1;
    if (tok.length > 5) {
      const h2 = hash32('stem:' + tok.slice(0, 5));
      v[h2 % dim]! += (h2 & 1 ? 1 : -1) * 0.7;
    }
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => Number((x / norm).toFixed(6)));
}

function isGerman(s: string): boolean {
  return /[äöüß]|\b(der|die|das|ist|und|was|wie|nicht|ich|ein|eine|welche|warum|erkläre|bitte)\b/i.test(s);
}

function firstSentence(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,220}?[.!?])(\s|$)/.exec(clean);
  return (m ? m[1]! : clean.slice(0, 160)).trim();
}

function buildAnswer(messages: { role: string; content: string }[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (/very short title/i.test(system + last)) {
    const q = /Question:\s*([\s\S]*?)\n/i.exec(last)?.[1] ?? last;
    return 'Mock: ' + q.split(/\s+/).slice(0, 4).join(' ');
  }
  const questionMatch = /(?:QUESTION|FRAGE)[^\n]*\n([\s\S]*)$/i.exec(last);
  const question = (questionMatch ? questionMatch[1]! : last).trim();
  const de = isGerman(question);
  const docs = [...last.matchAll(/<document index="(\d+)"[^>]*>\n?([\s\S]*?)<\/document>/g)].map((m) => ({ n: m[1]!, text: m[2]! }));
  if (last.includes('<documents')) {
    if (!docs.length) {
      return de
        ? 'Dazu finde ich in deinen Unterlagen leider nichts. *(Mock-Ollama)*'
        : "I couldn't find anything about this in your documents. *(Mock-Ollama)*";
    }
    const parts = docs.slice(0, 2).map((d, i) =>
      de
        ? `${i === 0 ? 'Laut deinen Unterlagen' : 'Ergänzend'}: „${firstSentence(d.text)}“ [${d.n}]`
        : `${i === 0 ? 'According to your documents' : 'Additionally'}: "${firstSentence(d.text)}" [${d.n}]`,
    );
    return `${parts.join('\n\n')}\n\n- ${de ? 'Punkt' : 'Point'} **A** [${docs[0]!.n}]\n- ${de ? 'Formel' : 'Formula'}: $E = mc^2$\n\n*(${de ? 'Antwort des Mock-Ollama – Testmodus' : 'Mock-Ollama answer – test mode'})*`;
  }
  return de
    ? `Mock-Antwort (freier Chat) auf: „${question.slice(0, 120)}“ *(Testmodus)*`
    : `Mock answer (free chat) to: "${question.slice(0, 120)}" *(test mode)*`;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const raw = Buffer.concat(parts).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function startMockOllama(opts: { port?: number; tokenDelayMs?: number } = {}): Promise<MockOllama> {
  const tokenDelay = opts.tokenDelayMs ?? 12;
  const requests: { path: string; body: unknown }[] = [];
  let down = false;
  let lastChatModel = 'gemma3:4b';

  const server = http.createServer(async (req, res) => {
    if (down) {
      req.socket.destroy();
      return;
    }
    const url = req.url ?? '/';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const body = req.method === 'POST' ? ((await readBody(req)) as Record<string, unknown>) : {};
      requests.push({ path: url, body });
      if (url === '/api/version') return json(200, { version: '0.0.0-mock' });
      if (url === '/api/tags') {
        return json(200, {
          models: MODELS.map((m) => ({ name: m.name, model: m.name, size: m.size, details: { family: m.family, parameter_size: m.params, quantization_level: 'Q4_K_M' } })),
        });
      }
      if (url === '/api/ps') {
        const m = findModel(lastChatModel);
        return json(200, { models: m ? [{ name: m.name, model: m.name, size: m.size + 600_000_000, size_vram: m.size + 600_000_000, context_length: 8192 }] : [] });
      }
      if (url === '/api/show') {
        const m = findModel(String(body.model ?? ''));
        if (!m) return json(404, { error: `model '${String(body.model)}' not found` });
        return json(200, { capabilities: m.caps, details: { family: m.family, parameter_size: m.params } });
      }
      if (url === '/api/embed') {
        const model = String(body.model ?? '');
        if (!findModel(model)) return json(404, { error: `model "${model}" not found, try pulling it first` });
        const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input ?? '')];
        const dim = embedDim(model);
        return json(200, { model, embeddings: input.map((t) => fakeEmbedding(String(t), dim)) });
      }
      if (url === '/api/chat') {
        const model = String(body.model ?? '');
        const m = findModel(model);
        if (!m || m.caps.includes('embedding')) return json(404, { error: `model "${model}" not found, try pulling it first` });
        if (body.think === true && !m.caps.includes('thinking')) return json(400, { error: `"${model}" does not support thinking` });
        lastChatModel = m.name;
        const messages = (body.messages as { role: string; content: string }[]) ?? [];
        const answer = buildAnswer(messages);
        const lastUser = [...messages].reverse().find((x) => x.role === 'user')?.content ?? '';
        const thinkingModel = m.caps.includes('thinking');
        if (body.stream === false) {
          return json(200, { model, message: { role: 'assistant', content: answer }, done: true });
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        let closed = false;
        res.on('close', () => (closed = true));
        const send = (obj: unknown) => !closed && res.write(JSON.stringify(obj) + '\n');
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        if (thinkingModel && body.think === true) {
          for (const w of 'Ich prüfe die bereitgestellten Quellen und formuliere eine Antwort. '.split(/(?<= )/)) {
            send({ model, message: { role: 'assistant', content: '', thinking: w }, done: false });
            await sleep(tokenDelay);
          }
        } else if (thinkingModel && body.think === undefined) {
          send({ model, message: { role: 'assistant', content: '<think>Inline-Denken (Mock). </think>' }, done: false });
        }
        const tokens = answer.split(/(?<=\s)/);
        let i = 0;
        for (const tok of tokens) {
          if (closed) return;
          if (lastUser.includes('__MOCK_ERROR__') && i === 3) {
            send({ error: 'mock failure (simulated)' });
            res.end();
            return;
          }
          send({ model, message: { role: 'assistant', content: tok }, done: false });
          i++;
          await sleep(tokenDelay);
        }
        send({ model, message: { role: 'assistant', content: '' }, done: true, eval_count: tokens.length, eval_duration: tokens.length * tokenDelay * 1e6 });
        res.end();
        return;
      }
      json(404, { error: 'not found' });
    } catch (err) {
      json(500, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setDown: (d) => (down = d),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
