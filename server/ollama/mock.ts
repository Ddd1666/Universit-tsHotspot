import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { imageSize } from '../media/image.ts';

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
  /** künstliche Verzögerung für /api/embed (Tests: Re-Index während laufendem Batch) */
  setEmbedDelay(ms: number): void;
  /** künstliche Verzögerung für Lern-Aufrufe (Tests: Chat unterbricht die Generierung) */
  setLearnDelay(ms: number): void;
  /** Lern-Aufrufe antworten mit diesem HTTP-Status (0 = normal; Tests: Bewertung scheitert an Ollama-Fehler) */
  setLearnStatus(status: number): void;
}

const MODELS: { name: string; size: number; family: string; params: string; caps: string[] }[] = [
  { name: 'gemma3:4b', size: 3_338_801_804, family: 'gemma3', params: '4.3B', caps: ['completion', 'vision'] },
  { name: 'qwen3:4b', size: 2_620_788_019, family: 'qwen3', params: '4.0B', caps: ['completion', 'tools', 'thinking'] },
  { name: 'qwen3:8b', size: 5_225_376_047, family: 'qwen3', params: '8.2B', caps: ['completion', 'tools', 'thinking'] },
  { name: 'llama3.1:8b', size: 4_920_753_328, family: 'llama', params: '8.0B', caps: ['completion', 'tools'] },
  { name: 'nomic-embed-text:latest', size: 274_302_450, family: 'nomic-bert', params: '137M', caps: ['embedding'] },
  { name: 'all-minilm:latest', size: 45_960_996, family: 'bert', params: '23M', caps: ['embedding'] },
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

/* ------------------------------------------------------------ Lernmodi (Phase 3): deterministische strukturierte Ausgaben */

function docsOf(text: string): { n: number; text: string }[] {
  return [...text.matchAll(/<document index="(\d+)"[^>]*>\n?([\s\S]*?)<\/document>/g)].map((m) => ({ n: Number(m[1]), text: m[2]!.trim() }));
}

/** Inhalt des letzten <tag>…</tag> (der System-Prompt erwähnt die Tags ebenfalls). */
function lastBlock(s: string, tag: string): string {
  const start = s.lastIndexOf(`<${tag}>`);
  const end = s.lastIndexOf(`</${tag}>`);
  return start === -1 || end < start ? '' : s.slice(start + tag.length + 2, end);
}

function longestWord(s: string): string {
  return (s.match(/[\p{L}-]{5,}/gu) ?? []).reduce((a, b) => (b.length > a.length ? b : a), '');
}

/**
 * Antworten für die Lern-Aufgaben (erkannt am "TASK: …" im System-Prompt). Marker im Dokumenttext steuern Tests:
 * MOCKBADJSON -> ungültige Ausgabe, MOCKHALLU -> erfundene (unplausible) Antwort, MOCKEMPTY -> leere Notiz.
 */
export function learnAnswer(task: string, user: string): string {
  const docs = docsOf(user);
  const any = (marker: string) => docs.some((d) => d.text.includes(marker)) || user.includes(marker);
  if (any('MOCKBADJSON')) return 'Das ist kein JSON {';
  const sentence = (d: { text: string }) => firstSentence(d.text);
  switch (task) {
    case 'summary-map':
      if (any('MOCKEMPTY')) return '';
      // MOCKWEAK: Stichpunkt, der nicht im Abschnitt steht (Plausibilitätsprüfung der Map-Ausgabe)
      return docs.map((d) => (d.text.includes('MOCKWEAK') ? `- Quantengravitation erklärt Dunkle Materie vollständig [${d.n}]` : `- ${sentence(d)} [${d.n}]`)).join('\n');
    case 'summary-reduce': {
      const notes = lastBlock(user, 'notes');
      const lines = notes.split('\n').filter((l) => l.trim().startsWith('- '));
      const level = /You turn study notes into (a TL;DR|a hierarchical outline|a detailed|an exam cheat sheet|merged study notes)/.exec(user)?.[1] ?? '';
      // "Zusammenführen": gleiche Aussagen zusammenlegen (Marker vereinigt), Zeilen kürzen – konvergiert wie bei einem echten Modell
      if (level === 'merged study notes') {
        const byText = new Map<string, string[]>();
        for (const l of lines) {
          const key = l.replace(/\[\d+\]/g, '').slice(0, 12).trim();
          byText.set(key, [...(byText.get(key) ?? []), ...(l.match(/\[\d+\]/g) ?? [])]);
        }
        return [...byText].map(([t, m]) => `${t} ${[...new Set(m)].join('')}`).join('\n');
      }
      return `## Mock-Zusammenfassung (${level || 'notes'})\n\n${(level === 'a TL;DR' ? lines.slice(0, 3) : lines).join('\n')}`;
    }
    case 'cards':
      return JSON.stringify({
        cards: docs.flatMap((d) => {
          const s = sentence(d);
          const w = longestWord(s);
          const qa = { type: 'qa', front: `Was gilt laut Abschnitt ${d.n}?`, back: d.text.includes('MOCKHALLU') ? 'Quantengravitation erklärt Dunkle Materie vollständig' : s, source: d.n };
          return w ? [qa, { type: 'cloze', front: s.replace(w, `{{${w}}}`), back: '', source: d.n }] : [qa];
        }),
      });
    case 'quiz':
      return JSON.stringify({
        questions: docs.flatMap((d) => {
          const i = hash32(d.text); // Fragetyp je Abschnitt deterministisch gemischt
          const s = sentence(d);
          const w = longestWord(s) || s.split(' ')[0]!;
          if (d.text.includes('MOCKHALLU')) return [{ type: 'short', question: 'Was sagt der Text über Quantengravitation?', answer: 'Erfundene Theorie der Dunklen Materie', explanation: 'erfunden', source: d.n }];
          const all = [
            { type: 'mc', question: `Welcher Begriff fehlt: ${s.replace(w, '…')}`, options: [w, 'Option B', 'Option C', 'Option D'], answer: w, explanation: s, source: d.n },
            { type: 'tf', question: s, answer: 'true', explanation: s, source: d.n },
            { type: 'cloze', question: s.replace(w, '___'), answer: w, explanation: s, source: d.n },
            { type: 'short', question: `Erkläre: ${s.split(' ').slice(0, 4).join(' ')} …`, answer: s, explanation: s, source: d.n },
          ];
          return [all[i % 4]!];
        }),
      });
    case 'graph': {
      const concepts: { name: string; description: string; source: number }[] = [];
      const relations: { from: string; to: string; label: string }[] = [];
      for (const d of docs) {
        const words = [...new Set(d.text.match(/\b\p{Lu}[\p{Ll}-]{3,}\b/gu) ?? [])].slice(0, 4);
        words.forEach((w, i) => {
          concepts.push({ name: w, description: sentence(d), source: d.n });
          if (i > 0) relations.push({ from: words[i - 1]!, to: w, label: 'hängt zusammen mit' });
        });
      }
      return JSON.stringify({ concepts, relations });
    }
    case 'grade': {
      const model = /MODEL ANSWER: ([^\n]*)/.exec(user)?.[1] ?? '';
      const answer = lastBlock(user, 'answer');
      const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
      const want = [...words(model)];
      const got = words(answer);
      // MOCKFULLPOINTS: Modell lässt sich zu voller Punktzahl überreden; MOCKNORUBRIC: Bewertung ohne Rubrik
      const fooled = answer.includes('MOCKFULLPOINTS');
      const score = fooled ? 1 : want.length ? want.filter((w) => got.has(w)).length / want.length : 0;
      return JSON.stringify({
        score,
        rubric: answer.includes('MOCKNORUBRIC')
          ? []
          : [
              { criterion: 'Kernaussage genannt', met: score >= 0.5 },
              { criterion: 'Fachbegriffe korrekt', met: score >= 0.8 },
            ],
        reasoning: score >= 0.5 ? 'Die Antwort trifft die Kernaussage (Mock).' : 'Die Kernaussage fehlt (Mock).',
        quotes: [
          ...(docs[0] ? [{ source: docs[0].n, text: docs[0].text.slice(0, 60) }] : []),
          { source: 1, text: 'Dieses Zitat steht nirgends im Text und muss verworfen werden' },
        ],
      });
    }
    default:
      return '';
  }
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
  let embedDelay = 0;
  let learnDelay = 0;
  let learnStatus = 0;
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
        if (embedDelay) await new Promise((r) => setTimeout(r, embedDelay));
        if (res.destroyed) return;
        const dim = embedDim(model);
        return json(200, { model, embeddings: input.map((t) => fakeEmbedding(String(t), dim)) });
      }
      if (url === '/api/chat') {
        const model = String(body.model ?? '');
        const m = findModel(model);
        if (!m || m.caps.includes('embedding')) return json(404, { error: `model "${model}" not found, try pulling it first` });
        if (body.think === true && !m.caps.includes('thinking')) return json(400, { error: `"${model}" does not support thinking` });
        lastChatModel = m.name;
        const messages = (body.messages as { role: string; content: string; images?: string[] }[]) ?? [];
        const image = messages.flatMap((x) => x.images ?? [])[0];
        if (image !== undefined) {
          // Vision (Phase 2): deterministische Fake-Analyse. Marker im Bild steuern Tests:
          // MOCKTEXT:<text> -> OCR-Text, MOCKBAD -> ungültiges JSON, MOCKREJECT -> Ollama lehnt das Bild ab
          if (!m.caps.includes('vision')) return json(500, { error: 'this model is missing data required for image input' });
          const buf = Buffer.from(image, 'base64');
          const raw = buf.toString('latin1');
          if (raw.includes('MOCKREJECT')) return json(500, { error: 'failed to process image: unsupported image format' });
          const size = imageSize(buf);
          const marker = /MOCKTEXT:([^\0\n]{1,500})/.exec(raw)?.[1];
          const dims = size ? `${size.width}x${size.height}` : '?';
          const content = raw.includes('MOCKBAD')
            ? 'Das ist kein JSON'
            : JSON.stringify({ text: marker ?? `Mock-OCR ${dims}`, description: `Mock-Bildbeschreibung eines Bildes mit ${dims} Pixeln (Testmodus).` });
          return json(200, { model, message: { role: 'assistant', content }, done: true });
        }
        const lastUser = [...messages].reverse().find((x) => x.role === 'user')?.content ?? '';
        const task = /^TASK: ([\w-]+)/.exec(messages.find((x) => x.role === 'system')?.content ?? '')?.[1];
        if (task) {
          // langsamer Lernaufruf (Test: Chat unterbricht die Generierung)
          const delay = lastUser.includes('__MOCK_SLOW_LEARN__') ? 1500 : learnDelay;
          if (delay)
            await new Promise<void>((r) => {
              const t = setTimeout(r, delay);
              res.on('close', () => {
                clearTimeout(t);
                r();
              });
            });
          if (res.destroyed) return;
          if (learnStatus) return json(learnStatus, { error: `mock learn failure ${learnStatus}` });
          return json(200, { model, message: { role: 'assistant', content: learnAnswer(task, messages.map((x) => x.content).join('\n')) }, done: true });
        }
        const answer = buildAnswer(messages);
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
        const delay = lastUser.includes('__MOCK_SLOW__') ? 120 : tokenDelay; // langsame Antwort (Stopp-Test)
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
          await sleep(delay);
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
    setEmbedDelay: (ms) => (embedDelay = ms),
    setLearnDelay: (ms) => (learnDelay = ms),
    setLearnStatus: (status) => (learnStatus = status),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
