// Messungen (Mock-Ollama, daher ohne echte Modell-Latenz):  npm run bench
//  1) Import-Durchsatz + RAM beim Import eines großen PDFs (Extraktion im Worker, Chunking, FTS)
//  2) Suchlatenz bei ~10k Chunks: FTS5, Vektor (int8 vs. float32 = vorher/nachher), Hybrid end-to-end
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ROOT, loadConfig } from '../server/config.ts';
import { createHotspot } from '../server/app.ts';
import { fakeEmbedding } from '../server/ollama/mock.ts';
import { SqliteVectorStore } from '../server/embed/vector-store.ts';
import { hybridSearch } from '../server/search/hybrid.ts';
import { makePdf } from '../tests/fixtures.ts';

const WORDS =
  'Energie Entropie Temperatur Druck Volumen Arbeit Wärme System Prozess Gleichgewicht Zustand Reaktion Molekül Teilchen Kraft Masse Beschleunigung Impuls Feld Spannung Strom Widerstand Matrix Vektor Integral Ableitung Funktion Grenzwert Folge Reihe Wahrscheinlichkeit Verteilung Erwartungswert Varianz Hypothese Signifikanz Algorithmus Komplexität Graph Baum Sortierung Datenbank Netzwerk Protokoll Zelle Protein Enzym Genom Evolution Ökosystem Markt Preis Nachfrage Angebot Inflation Theorie Modell Experiment Messung Fehler'.split(
    ' ',
  );
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const sentence = () => {
  const n = 8 + Math.floor(rnd() * 10);
  const w = Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]!.toLowerCase());
  w[0] = w[0]![0]!.toUpperCase() + w[0]!.slice(1);
  return w.join(' ') + '.';
};
const pct = (arr: number[], p: number) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]!;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

const root = path.join(PROJECT_ROOT, '.tmp', 'bench');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const report: string[] = [];

/* ------------------------------------------------------------ 1) großes PDF */
{
  const pages = Array.from({ length: 400 }, (_, p) => [`Kapitel ${p + 1}`, '', ...Array.from({ length: 28 }, sentence)]);
  const pdf = makePdf(pages);
  const token = crypto.randomBytes(32).toString('hex');
  const hs = await createHotspot(loadConfig({ dataDir: path.join(root, 'import'), port: 0, token, mockOllama: true, webDir: null, logToFile: false }));
  const { url } = await hs.listen();
  global.gc?.();
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
  const t0 = performance.now();
  const res = await fetch(url + '/api/import', {
    method: 'POST',
    headers: { 'x-hotspot-token': token, 'content-type': 'application/octet-stream', 'x-file-name': 'gross.pdf' },
    body: pdf,
  });
  const { source } = (await res.json()) as { source: { id: number } };
  let s: { status: string; chunkCount: number } = { status: '', chunkCount: 0 };
  while (!['ready', 'error'].includes(s.status)) {
    await new Promise((r) => setTimeout(r, 20));
    s = hs.services.library.getSource(source.id)!;
  }
  const tExtract = performance.now() - t0;
  while (hs.services.embed.status().pending > 0) await new Promise((r) => setTimeout(r, 20));
  const tTotal = performance.now() - t0;
  clearInterval(sampler);
  report.push(
    `Großes PDF: ${pages.length} Seiten, ${(pdf.length / 1024 / 1024).toFixed(1)} MB, ${s.chunkCount} Chunks`,
    `  Extraktion+Chunking+FTS (Worker):  ${ms(tExtract)}  -> ${(s.chunkCount / (tExtract / 1000)).toFixed(0)} Chunks/s, ${(pages.length / (tExtract / 1000)).toFixed(0)} Seiten/s`,
    `  inkl. Mock-Embeddings (Batch 16):  ${ms(tTotal)}  -> ${(s.chunkCount / (tTotal / 1000)).toFixed(0)} Chunks/s (echtes Ollama: deutlich langsamer, s. README)`,
    `  RAM (RSS Prozess inkl. Worker): vorher ${mb(rss0)}, Spitze ${mb(peak)} (+${mb(peak - rss0)})`,
  );

  // Event-Loop bleibt reaktionsfähig? Latenz eines API-Calls während eines weiteren Imports
  const pdf2 = makePdf(pages.slice(0, 200).map((p) => [...p, 'Zusatz']));
  const imp = fetch(url + '/api/import', {
    method: 'POST',
    headers: { 'x-hotspot-token': token, 'content-type': 'application/octet-stream', 'x-file-name': 'gross2.pdf' },
    body: pdf2,
  });
  const lat: number[] = [];
  for (let i = 0; i < 40; i++) {
    const a = performance.now();
    await fetch(url + '/api/health', { headers: { 'x-hotspot-token': token } });
    lat.push(performance.now() - a);
    await new Promise((r) => setTimeout(r, 15));
  }
  await imp;
  report.push(`  API-Latenz während paralleler PDF-Verarbeitung: p50 ${ms(pct(lat, 0.5))}, max ${ms(Math.max(...lat))}`);
  await hs.close();
}

/* ------------------------------------------------------------ 2) Suche bei ~10k Chunks */
{
  const N = 10_000;
  const DIM = 768;
  const token = crypto.randomBytes(32).toString('hex');
  const hs = await createHotspot(loadConfig({ dataDir: path.join(root, 'search'), port: 0, token, mockOllama: true, webDir: null, logToFile: false }));
  const { db } = hs.services;
  await hs.listen();
  await hs.services.embed.stop(); // Vektoren hier direkt schreiben
  const t0 = performance.now();
  db.exec('BEGIN');
  const insSrc = db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, 1, 'text/plain', 'text', 'ready', 0, 100)");
  const insChunk = db.prepare('INSERT INTO chunks(source_id, ord, text, token_est, embed_state) VALUES (?, ?, ?, 150, 1)');
  const items: { chunkId: number; sourceId: number; vector: Float32Array }[] = [];
  for (let s = 0; s < N / 100; s++) {
    const sid = Number(insSrc.run(crypto.randomBytes(32).toString('hex'), `quelle-${s}.pdf`).lastInsertRowid);
    for (let c = 0; c < 100; c++) {
      const text = Array.from({ length: 6 }, sentence).join(' ');
      const id = Number(insChunk.run(sid, c, text).lastInsertRowid);
      items.push({ chunkId: id, sourceId: sid, vector: Float32Array.from(fakeEmbedding(text, DIM)) });
    }
  }
  db.exec('COMMIT');
  const store = hs.services.vectors;
  store.setIndex('nomic-embed-text', DIM);
  store.upsert(items);
  const tBuild = performance.now() - t0;

  const queries = Array.from({ length: 60 }, () => `${WORDS[Math.floor(rnd() * WORDS.length)]} ${WORDS[Math.floor(rnd() * WORDS.length)]}`);
  const qVecs = queries.map((q) => Float32Array.from(fakeEmbedding(q, DIM)));

  const ftsLat: number[] = [];
  const ftsStmt = db.prepare(
    "SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 40",
  );
  for (const q of queries) {
    const a = performance.now();
    ftsStmt.all(q.toLowerCase().split(' ').map((w) => `"${w}"`).join(' OR '));
    ftsLat.push(performance.now() - a);
  }

  const measure = (vs: SqliteVectorStore) => {
    vs.invalidate();
    const a = performance.now();
    vs.search(qVecs[0]!, 40, null); // Cache laden
    const load = performance.now() - a;
    const lat = qVecs.map((v) => {
      const b = performance.now();
      vs.search(v, 40, null);
      return performance.now() - b;
    });
    return { load, lat, mem: vs.memoryBytes() };
  };
  const f32 = measure(new SqliteVectorStore(db, { quantize: false }));
  const q8 = measure(store);

  const hybLat: number[] = [];
  for (const q of queries.slice(0, 30)) {
    const r = await hybridSearch({ db, vectors: store, client: hs.services.client }, q, { limit: 10 });
    hybLat.push(r.tookMs);
  }
  report.push(
    '',
    `Suche bei ${N.toLocaleString('de-DE')} Chunks (${DIM}-dim. Vektoren; Aufbau ${ms(tBuild)}):`,
    `  FTS5/BM25:                    p50 ${ms(pct(ftsLat, 0.5))}, p95 ${ms(pct(ftsLat, 0.95))}`,
    `  Vektor float32 (vorher):      p50 ${ms(pct(f32.lat, 0.5))}, p95 ${ms(pct(f32.lat, 0.95))}, Cache ${mb(f32.mem)}, Laden ${ms(f32.load)}`,
    `  Vektor int8 (nachher):        p50 ${ms(pct(q8.lat, 0.5))}, p95 ${ms(pct(q8.lat, 0.95))}, Cache ${mb(q8.mem)}, Laden ${ms(q8.load)}`,
    `  Hybrid gesamt (inkl. Query-Embedding via Mock-HTTP, RRF, Metadaten): p50 ${ms(pct(hybLat, 0.5))}, p95 ${ms(pct(hybLat, 0.95))}`,
    `  Hochrechnung Vektor int8 bei 100k Chunks: ~${ms(pct(q8.lat, 0.5) * 10)} / Cache ~${mb(q8.mem * 10)}`,
  );
  await hs.close();
}

console.log('\n' + report.join('\n') + '\n');
fs.rmSync(root, { recursive: true, force: true });
