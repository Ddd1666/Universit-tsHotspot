// Qualitäts-Check der Lernmodi an ECHTEN Unterlagen mit dem ECHTEN lokalen Modell – zur manuellen Bewertung.
// Das Skript misst nur Laufzeiten; Qualität bewertet der Nutzer selbst im erzeugten Bericht (keine erfundenen Kennzahlen).
//
//   node --disable-warning=ExperimentalWarning scripts/eval-learning.ts <Datei|Ordner> [weitere …] [--model gemma3:4b] [--out <Ordner>] [--mock]
//
// - nutzt einen eigenen, temporären Datenordner unter .tmp/eval/ (der echte Datenordner bleibt unberührt)
// - lädt die Dateien hoch, wartet auf Text + Embeddings, erzeugt je Quelle: Gliederung, Spickzettel, Karten, Quizfragen, Graph
// - prüft die Freitext-Bewertung je zweimal (Musterlösung vs. falsche Antwort)
// - schreibt eval-learning-<Zeit>.md (zum Ausfüllen) + .json (Rohdaten) nach --out (Standard: .tmp/eval/)
// --mock nur zum Ausprobieren des Skripts (Mock-Ollama, Ergebnisse ohne Aussagekraft)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT, loadConfig } from '../server/config.ts';
import { createHotspot } from '../server/app.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v ?? null;
};
const mock = args.includes('--mock');
if (mock) args.splice(args.indexOf('--mock'), 1);
const model = flag('--model');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const outDir = path.resolve(flag('--out') ?? path.join(PROJECT_ROOT, '.tmp', 'eval'));
const inputs = args.flatMap((a) => {
  const p = path.resolve(a);
  if (!fs.existsSync(p)) throw new Error(`nicht gefunden: ${p}`);
  return fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)).filter((f) => fs.statSync(f).isFile()) : [p];
});
if (!inputs.length) {
  console.log('Aufruf: node scripts/eval-learning.ts <Datei|Ordner> [--model <name>] [--out <ordner>] [--mock]');
  process.exit(1);
}
const files = inputs.slice(0, 10);
if (inputs.length > 10) console.log(`Hinweis: nur die ersten 10 von ${inputs.length} Dateien werden ausgewertet.`);

const dataDir = path.join(PROJECT_ROOT, '.tmp', 'eval', `run-${stamp}`);
const token = crypto.randomBytes(32).toString('hex');
const hs = await createHotspot(loadConfig({ dataDir, port: 0, token, mockOllama: mock, webDir: null, logToFile: true }));
const { url } = await hs.listen();
const h = { 'x-hotspot-token': token };
const api = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await fetch(url + p, { method, headers: { ...h, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = (await r.json()) as T & { error?: string; message?: string };
  if (!r.ok) throw new Error(`${p}: ${j.error} ${j.message}`);
  return j;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => Promise<T | null>, maxMin: number, what: string): Promise<T> => {
  const end = Date.now() + maxMin * 60_000;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${what}`);
    await sleep(1000);
  }
};

try {
  const ollama = await api<{ reachable: boolean; version: string | null; models: { name: string }[] }>('POST', '/api/ollama/refresh');
  if (!ollama.reachable) throw new Error('Ollama ist nicht erreichbar – bitte Ollama starten.');
  if (model) await api('PUT', '/api/settings', { chatModel: model, visionModel: model });
  const settings = (await api<{ settings: { chatModel: string; numCtx: number; embeddingModel: string; language: string } }>('GET', '/api/settings')).settings;
  console.log(`Modell ${settings.chatModel} · num_ctx ${settings.numCtx} · Embedding ${settings.embeddingModel}${mock ? ' · MOCK (ohne Aussagekraft)' : ''}`);

  // 1) Import
  const sources: { id: number; name: string }[] = [];
  for (const f of files) {
    const res = await fetch(url + '/api/import', {
      method: 'POST',
      headers: { ...h, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(path.basename(f)) },
      body: fs.readFileSync(f),
    });
    const j = (await res.json()) as { source: { id: number; name: string } };
    sources.push({ id: j.source.id, name: j.source.name });
  }
  const ready: { id: number; name: string; chunks: number }[] = [];
  for (const s of sources) {
    const src = await until(
      async () => {
        const r = await api<{ source: { status: string; chunkCount: number } }>('GET', `/api/sources/${s.id}`);
        return ['ready', 'error', 'unsupported', 'cancelled'].includes(r.source.status) ? r.source : null;
      },
      60,
      `Import ${s.name}`,
    );
    if (src.status === 'ready' && src.chunkCount > 0) ready.push({ ...s, chunks: src.chunkCount });
    else console.log(`übersprungen: ${s.name} (${src.status})`);
  }
  await until(async () => (hs.services.embed.status().pending === 0 ? true : null), 30, 'Embeddings');

  // 2) Generierung je Quelle (Laufzeit wird gemessen)
  type Job = { id: number; state: string; detail: string | null; result: Record<string, number> | null };
  const run = async (body: unknown): Promise<Job & { seconds: number }> => {
    const t0 = Date.now();
    const j = await api<Job>('POST', '/api/learn/jobs', body);
    const done = await until(
      async () => {
        const x = hs.services.learn.get(j.id);
        return x && ['done', 'error', 'cancelled'].includes(x.state) ? x : null;
      },
      120,
      'Lern-Job',
    );
    return { ...done, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  };
  const report: Record<string, unknown>[] = [];
  const md: string[] = [
    `# Uni-Hotspot – Qualitäts-Check Lernmodi (${stamp})`,
    '',
    `Modell **${settings.chatModel}**, num_ctx ${settings.numCtx}, Embedding ${settings.embeddingModel}${mock ? ' – **MOCK, ohne Aussagekraft**' : ''}. Ollama ${ollama.version ?? '?'}.`,
    '',
    'Bitte jede Ausgabe bewerten: **1** = unbrauchbar … **5** = sehr gut. Kriterien: sachlich richtig? passend zur Quelle? Quellenangaben stimmen? Sprache ok?',
    'Laufzeiten sind gemessen (inkl. Wartezeit auf das Modell).',
    '',
  ];
  const rate = '\n**Bewertung (1–5):** ___  **Kommentar:** ___\n';
  for (const s of ready) {
    console.log(`→ ${s.name} (${s.chunks} Abschnitte)`);
    const scope = { kind: 'source', id: s.id };
    const outline = await run({ kind: 'summary', scope, level: 'outline' });
    const cheat = await run({ kind: 'summary', scope, level: 'cheatsheet' });
    const cards = await run({ kind: 'cards', scope, count: 10 });
    const quiz = await run({ kind: 'quiz', scope, count: 8 });
    const graph = await run({ kind: 'graph', scope });
    md.push(`## ${s.name} (${s.chunks} Abschnitte)`, '');
    for (const [label, j] of [['Gliederung', outline], ['Klausur-Spickzettel', cheat]] as const) {
      md.push(`### Zusammenfassung: ${label} – ${j.state}, ${j.seconds} s`, '');
      if (j.result?.noteId) {
        const n = await api<{ body: string; citations: { n: number; sourceName: string; loc: { k: string; s: number } | null; heading: string | null }[] }>('GET', `/api/notes/${j.result.noteId}`);
        md.push(n.body, '', '_Quellen:_ ' + n.citations.map((c) => `[${c.n}] ${c.loc ? `${c.loc.k} ${c.loc.s}` : ''}${c.heading ? ` (${c.heading})` : ''}`).join(' · '), rate);
      } else md.push(`Fehler: ${j.detail}`, rate);
    }
    md.push(`### Karteikarten – ${cards.state}, ${cards.seconds} s, ${JSON.stringify(cards.result)}`, '');
    const cl = (await api<{ items: { type: string; front: string; back: string; loc: { k: string; s: number } | null }[] }>('GET', `/api/cards?job=${cards.id}`)).items;
    md.push('| # | Typ | Vorderseite | Rückseite | Stelle | Note 1–5 |', '|---|---|---|---|---|---|');
    cl.forEach((c, i) => md.push(`| ${i + 1} | ${c.type} | ${c.front.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${c.back.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${c.loc ? `${c.loc.k} ${c.loc.s}` : ''} | |`));
    md.push('');
    md.push(`### Quizfragen – ${quiz.state}, ${quiz.seconds} s, ${JSON.stringify(quiz.result)}`, '');
    const qs = hs.services.db
      .prepare('SELECT id, type, question, options, answer, explanation FROM quiz_questions WHERE source_id = ? ORDER BY id')
      .all(s.id) as { id: number; type: string; question: string; options: string | null; answer: string; explanation: string }[];
    md.push('| # | Typ | Frage | Lösung | Begründung | Note 1–5 |', '|---|---|---|---|---|---|');
    qs.forEach((q, i) => md.push(`| ${i + 1} | ${q.type} | ${q.question.replace(/\|/g, '\\|').replace(/\n/g, ' ')}${q.options ? ` (${JSON.parse(q.options).join(' / ')})` : ''} | ${q.answer.replace(/\|/g, '\\|')} | ${(q.explanation ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} | |`));
    md.push('');
    const short = qs.filter((q) => q.type === 'short').slice(0, 2);
    if (short.length) {
      md.push('### Freitext-Bewertung (Musterlösung vs. falsche Antwort)', '');
      for (const q of short) {
        for (const [label, answer] of [['Musterlösung', q.answer], ['falsch', 'Das hat damit nichts zu tun.']] as const) {
          const t0 = Date.now();
          const r = await api<{ score: number; feedback: { reasoning: string; rubric: { criterion: string; met: boolean }[]; quotes: { text: string }[] } | null }>('POST', `/api/quiz/questions/${q.id}/answer`, { answer });
          md.push(`- **${q.question}** – Antwort „${label}“: Punkte ${r.score} (${Math.round((Date.now() - t0) / 100) / 10} s). ${r.feedback?.reasoning ?? ''} Rubrik: ${r.feedback?.rubric.map((x) => `${x.met ? '✓' : '✗'} ${x.criterion}`).join('; ') ?? '–'}. Belege: ${r.feedback?.quotes.length ?? 0}`);
        }
      }
      md.push(rate);
    }
    md.push(`### Wissensgraph – ${graph.state}, ${graph.seconds} s, ${JSON.stringify(graph.result)}`, '');
    const g = await api<{ nodes: { id: number; name: string }[]; edges: { a: number; b: number; label: string }[] }>('GET', `/api/graph?source=${s.id}&hidden=true`);
    const name = new Map(g.nodes.map((n) => [n.id, n.name]));
    md.push(`Konzepte: ${g.nodes.map((n) => n.name).join(', ')}`, '', 'Beziehungen:', ...g.edges.map((e) => `- ${name.get(e.a)} — ${e.label} — ${name.get(e.b)}`), rate);
    report.push({ source: s, outline, cheat, cards, quiz, graph, cardsList: cl, questions: qs, graphData: g });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `eval-learning-${stamp}`);
  fs.writeFileSync(`${base}.md`, md.join('\n') + '\n');
  fs.writeFileSync(`${base}.json`, JSON.stringify({ settings, mock, report }, null, 2));
  console.log(`\nBericht zum Ausfüllen: ${base}.md\nRohdaten: ${base}.json`);
} finally {
  await hs.close();
}
