// Phase-4-Messungen (Mock-Ollama):  npm run bench:phase4 [-- --chunks 100000]
//  1) Serverstart (createHotspot + listen) und RAM: leerer Datenordner / 2000 Quellen + 40k Abschnitte (inkl. Vektor-Cache)
//  2) Hybrid-Suche bei 100k Abschnitten (768-dim.): FTS, Vektor (int8), Hybrid gesamt – Schwelle für ein ANN-Backend: p50 > 150 ms
//  3) Bibliotheksliste bei 20 000 Quellen (erste Seite)
//  4) Sicherung (Snapshot) und Wiederherstellung der 40k-DB, Event-Loop-Blockade dabei
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PROJECT_ROOT, loadConfig } from '../server/config.ts';
import { createHotspot, type Hotspot } from '../server/app.ts';
import { fakeEmbedding } from '../server/ollama/mock.ts';
import { hybridSearch } from '../server/search/hybrid.ts';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const N_SEARCH = arg('--chunks', 100_000);
const DIM = 768;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
// Wortschatz ~4000 Kunstwörter mit Zipf-Verteilung (realistischer als 50 Fachwörter, die in jedem Abschnitt vorkommen)
const SYL = ['ka', 'te', 'ro', 'mi', 'su', 'lo', 'ne', 'pa', 'di', 'gu', 'ver', 'ent', 'ung', 'keit', 'sch', 'tr', 'al', 'or', 'is', 'an'];
const WORDS = Array.from({ length: 4000 }, (_, i) => SYL[i % 20]! + SYL[Math.floor(i / 20) % 20]! + SYL[Math.floor(i / 400) % 20]!);
const zipf = () => WORDS[Math.min(WORDS.length - 1, Math.floor(Math.exp(rnd() * Math.log(WORDS.length))) - 1)]!;
const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 8) }, zipf).join(' ') + '.';
/** Suchbegriffe mittlerer Häufigkeit (Rang 20–500) */
const queryWord = () => WORDS[20 + Math.floor(rnd() * 480)]!;
/** RSS eines anderen Prozesses (Windows: Arbeitsspeicher laut Get-Process; Linux: /proc) */
function rssOf(pid: number): number {
  if (process.platform === 'win32') return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`], { encoding: 'utf8' }).trim());
  const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  return m ? Number(m[1]) * 1024 : 0;
}
const pct = (arr: number[], p: number) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]!;
const ms = (n: number) => `${n.toFixed(1)} ms`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const sleep = (t: number) => new Promise((r) => setTimeout(r, t));

const root = path.join(PROJECT_ROOT, '.tmp', 'bench4');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
const report: string[] = [];
const cfg = (dir: string) => loadConfig({ dataDir: path.join(root, dir), port: 0, token: crypto.randomBytes(32).toString('hex'), mockOllama: true, webDir: null, logToFile: false, toolsDir: path.join(root, 'tools') });

/** Quellen + Abschnitte (+ Vektoren) direkt in die DB schreiben. */
function fill(hs: Hotspot, sources: number, perSource: number, vectors: boolean): void {
  const { db } = hs.services;
  // Index ZUERST festlegen: setIndex mit neuem Modell verwirft vorhandene Vektoren
  if (vectors) hs.services.vectors.setIndex('nomic-embed-text', DIM);
  db.exec('BEGIN');
  const insSrc = db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, 1, 'text/plain', 'text', 'ready', ?, ?)");
  const insChunk = db.prepare('INSERT INTO chunks(source_id, ord, text, token_est, embed_state) VALUES (?, ?, ?, 150, ?)');
  const insVec = db.prepare('INSERT INTO embeddings(chunk_id, source_id, vec) VALUES (?, ?, ?)');
  for (let s = 0; s < sources; s++) {
    const sid = Number(insSrc.run(crypto.randomBytes(32).toString('hex'), `quelle-${s}.pdf`, s, perSource).lastInsertRowid);
    for (let c = 0; c < perSource; c++) {
      const text = Array.from({ length: 5 }, sentence).join(' ');
      const id = Number(insChunk.run(sid, c, text, vectors ? 1 : 0).lastInsertRowid);
      if (vectors) {
        const v = Float32Array.from(fakeEmbedding(text, DIM));
        insVec.run(id, sid, new Uint8Array(v.buffer));
      }
    }
  }
  db.exec('COMMIT');
  hs.services.vectors.invalidate();
}

async function startMeasured(dir: string): Promise<{ hs: Hotspot; ms: number }> {
  const a = performance.now();
  const hs = await createHotspot(cfg(dir));
  await hs.listen();
  return { hs, ms: performance.now() - a };
}

/** Kaltstart wie im Browser-Modus: eigener Prozess `node server/main.ts`, Zeit bis /api/health antwortet, RSS danach. */
async function coldStart(dir: string, port: number): Promise<{ readyMs: number; rssReady: number; rssLater: number }> {
  const a = performance.now();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'server', 'main.ts')], {
    env: { ...process.env, HOTSPOT_DATA_DIR: path.join(root, dir), HOTSPOT_PORT: String(port), HOTSPOT_MOCK_OLLAMA: '1' },
    stdio: 'ignore',
  });
  let readyMs = 0;
  for (let i = 0; i < 400 && !readyMs; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.status === 401) readyMs = performance.now() - a;
    } catch {
      await sleep(10);
    }
  }
  const rssReady = rssOf(child.pid!);
  await sleep(3000); // Wartung (Vektor-Cache, GC verwaister Dateien) nach 1,5 s
  const rssLater = rssOf(child.pid!);
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await sleep(300);
  fs.rmSync(path.join(root, dir, 'hotspot.lock'), { force: true });
  return { readyMs, rssReady, rssLater };
}

/* ------------------------------------------------------------ 1) Start + RAM */
{
  const prep = await createHotspot(cfg('big'));
  await prep.listen();
  await prep.services.embed.stop();
  fill(prep, 2000, 20, true);
  await prep.close();
  type Run = { empty: Awaited<ReturnType<typeof coldStart>>; big: Awaited<ReturnType<typeof coldStart>> };
  const runs: Run[] = [];
  for (let i = 0; i < 3; i++) runs.push({ empty: await coldStart(`empty${i}`, 4600 + i), big: await coldStart('big', 4610 + i) });
  const med = (f: (r: Run) => number) => pct(runs.map(f), 0.5);
  report.push(
    `Kaltstart Browser-Modus (eigener Prozess node server/main.ts bis /api/health antwortet; Median aus 3; Mock-Ollama im Prozess):`,
    `  leerer Datenordner: ${ms(med((r) => r.empty.readyMs))}; RSS bereit ${mb(med((r) => r.empty.rssReady))}, nach 3 s ${mb(med((r) => r.empty.rssLater))}`,
    `  2000 Quellen / 40 000 Abschnitte + Vektoren: ${ms(med((r) => r.big.readyMs))}; RSS bereit ${mb(med((r) => r.big.rssReady))}, nach 3 s (Vektor-Cache geladen) ${mb(med((r) => r.big.rssLater))}`,
  );
  const big = await startMeasured('big');
  // Sicherung/Wiederherstellung derselben DB (nur wenn die Funktion existiert – Vorher-Messung auf älterem Stand)
  const backup = (big.hs.services as unknown as { backup?: { create(reason: string): Promise<{ id: string; files: number }> } }).backup;
  if (backup) {
    const eld = monitorEventLoopDelay({ resolution: 5 });
    eld.enable();
    const b0 = performance.now();
    const snap = await backup.create('manual');
    const tb = performance.now() - b0;
    eld.disable();
    const dbSize = fs.statSync(path.join(root, 'big', 'hotspot.sqlite')).size;
    report.push(`  Sicherung (Backup-API, 40k Abschnitte, DB ${mb(dbSize)}): ${ms(tb)}; Event-Loop max ${ms(eld.max / 1e6)}, p99 ${ms(eld.percentile(99) / 1e6)}`);
    const restore = (big.hs.services as unknown as { backup: { stageRestore(id: string): Promise<unknown> } }).backup;
    const r0 = performance.now();
    await restore.stageRestore(snap.id);
    const tStage = performance.now() - r0;
    await big.hs.close();
    const again = await startMeasured('big');
    report.push(`  Wiederherstellen: vorbereiten (inkl. Sicherung des Ist-Zustands) ${ms(tStage)}, Neustart inkl. Austausch ${ms(again.ms)}`);
    await again.hs.close();
  } else await big.hs.close();
}

/* ------------------------------------------------------------ 2) Hybrid-Suche bei 100k Abschnitten */
{
  const prep = await createHotspot(cfg('search'));
  await prep.listen();
  await prep.services.embed.stop();
  const t0 = performance.now();
  fill(prep, N_SEARCH / 100, 100, true);
  const tBuild = performance.now() - t0;
  const { db, vectors, client } = prep.services;
  const queries = Array.from({ length: 40 }, () => `${queryWord()} ${queryWord()}`);
  const a = performance.now();
  vectors.warmup();
  const tLoad = performance.now() - a;
  const vecLat = queries.map((q) => {
    const v = Float32Array.from(fakeEmbedding(q, DIM));
    const b = performance.now();
    vectors.search(v, 40, null);
    return performance.now() - b;
  });
  const ftsStmt = db.prepare('SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 40');
  const ftsLat = queries.map((q) => {
    const b = performance.now();
    ftsStmt.all(q.toLowerCase().split(' ').map((w) => `"${w}"`).join(' OR '));
    return performance.now() - b;
  });
  const hyb: number[] = [];
  for (const q of queries.slice(0, 30)) hyb.push((await hybridSearch({ db, vectors, client }, q, { limit: 10 })).tookMs);
  report.push(
    '',
    `Suche bei ${N_SEARCH.toLocaleString('de-DE')} Abschnitten (${DIM}-dim.; Aufbau ${(tBuild / 1000).toFixed(1)} s, Vektor-Cache laden ${ms(tLoad)}, ${mb(vectors.memoryBytes())}):`,
    `  FTS5/BM25 p50 ${ms(pct(ftsLat, 0.5))}, p95 ${ms(pct(ftsLat, 0.95))}`,
    `  Vektor int8 (Brute-Force) p50 ${ms(pct(vecLat, 0.5))}, p95 ${ms(pct(vecLat, 0.95))}`,
    `  Hybrid gesamt (Query-Embedding via Mock-HTTP + FTS + Vektor + RRF) p50 ${ms(pct(hyb, 0.5))}, p95 ${ms(pct(hyb, 0.95))}  [Schwelle ANN: p50 > 150 ms]`,
  );
  await prep.close();
}

/* ------------------------------------------------------------ 3) Bibliotheksliste bei 20 000 Quellen */
{
  const prep = await createHotspot(cfg('list'));
  const { url } = await prep.listen();
  await prep.services.embed.stop();
  fill(prep, 20_000, 1, false);
  const h = { 'x-hotspot-token': prep.services.config.token };
  const lat: number[] = [];
  let shown = 0;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const a = performance.now();
    const r = (await (await fetch(url + '/api/sources?subject=all', { headers: h })).json()) as { items: unknown[]; total: number };
    lat.push(performance.now() - a);
    shown = r.items.length;
    total = r.total;
  }
  const deep: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = performance.now();
    await fetch(url + '/api/sources?subject=all&offset=19500', { headers: h });
    deep.push(performance.now() - a);
  }
  report.push('', `Bibliotheksliste 20 000 Quellen: erste Anfrage ${shown} von ${total} Einträgen p50 ${ms(pct(lat, 0.5))}; Seite bei Versatz 19 500 p50 ${ms(pct(deep, 0.5))}`);
  await prep.close();
}

console.log('\n' + report.join('\n') + '\n');
fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
