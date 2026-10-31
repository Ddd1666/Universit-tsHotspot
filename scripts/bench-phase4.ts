// Phase-4-Messungen (Mock-Ollama):  npm run bench:phase4 [-- --chunks 100000]
//  1) Serverstart (createHotspot + listen) und RAM: leerer Datenordner / 2000 Quellen + 40k Abschnitte (inkl. Vektor-Cache)
//  2) Hybrid-Suche bei 100k Abschnitten (768-dim.): FTS, Vektor (int8), Hybrid gesamt – Schwelle für ein ANN-Backend: p50 > 150 ms
//  3) Bibliotheksliste bei 20 000 Quellen (erste Seite)
//  4) Sicherung (Snapshot) und Wiederherstellung der 40k-DB, Event-Loop-Blockade dabei
import fs from 'node:fs';
import os from 'node:os';
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
const strArg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : null;
};
const N_SEARCH = arg('--chunks', 100_000);
// --only search: nur Teil 2; --rounds N: Suchläufe (Median); --db <ordner>: 100k-Datenordner wiederverwenden/behalten (A/B
// zweier Code-Stände auf derselben DB, gleiche Suchbegriffe)
const ONLY = strArg('--only');
const ROUNDS = arg('--rounds', 5);
const DB_DIR = strArg('--db');
const run = (part: string) => !ONLY || ONLY === part;
/** Rechnerlast in % (Windows: Win32_Processor.LoadPercentage, sonst loadavg je Kern) */
function cpuLoad(): string {
  if (process.platform !== 'win32') return `${((os.loadavg()[0]! / os.cpus().length) * 100).toFixed(0)} %`;
  return `${execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average'], { encoding: 'utf8' }).trim()} %`;
}
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
const cfg = (dir: string) => loadConfig({ dataDir: path.isAbsolute(dir) ? dir : path.join(root, dir), port: 0, token: crypto.randomBytes(32).toString('hex'), mockOllama: true, webDir: null, logToFile: false, toolsDir: path.join(root, 'tools') });

/** Quellen + Abschnitte (+ Vektoren) direkt in die DB schreiben. */
function fill(hs: Hotspot, sources: number, perSource: number, vectors: boolean, blobs = false): void {
  const { db } = hs.services;
  const filesDir = path.join(hs.services.config.dataDir, 'files');
  // Index ZUERST festlegen: setIndex mit neuem Modell verwirft vorhandene Vektoren
  if (vectors) hs.services.vectors.setIndex('nomic-embed-text', DIM);
  db.exec('BEGIN');
  const insSrc = db.prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at, chunk_count) VALUES (?, ?, 1, 'text/plain', 'text', 'ready', ?, ?)");
  const insChunk = db.prepare('INSERT INTO chunks(source_id, ord, text, token_est, embed_state) VALUES (?, ?, ?, 150, ?)');
  const insVec = db.prepare('INSERT INTO embeddings(chunk_id, source_id, vec) VALUES (?, ?, ?)');
  for (let s = 0; s < sources; s++) {
    const sha = crypto.randomBytes(32).toString('hex');
    const sid = Number(insSrc.run(sha, `quelle-${s}.pdf`, s, perSource).lastInsertRowid);
    if (blobs) {
      // Originaldatei-Attrappe: der Datei-GC beim Start liest alle Hash-Namen ein
      fs.mkdirSync(path.join(filesDir, sha.slice(0, 2)), { recursive: true });
      fs.writeFileSync(path.join(filesDir, sha.slice(0, 2), sha), '');
    }
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
async function coldStart(dir: string, port: number, compileCache = false): Promise<{ readyMs: number; rssReady: number; rssLater: number }> {
  const a = performance.now();
  const env: NodeJS.ProcessEnv = { ...process.env, HOTSPOT_DATA_DIR: path.join(root, dir), HOTSPOT_PORT: String(port), HOTSPOT_MOCK_OLLAMA: '1' };
  delete env.NODE_COMPILE_CACHE;
  // start.bat/start.mjs setzen NODE_COMPILE_CACHE (Projektordner/.cache) -> ab dem zweiten Start schneller
  if (compileCache) env.NODE_COMPILE_CACHE = path.join(root, 'compile-cache');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'server', 'main.ts')], { env, stdio: 'ignore' });
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

report.push(`Rechnerlast vor dem Lauf: ${cpuLoad()} (${os.cpus().length} logische Kerne, ${os.cpus()[0]?.model.trim()})`, '');

/* ------------------------------------------------------------ 1) Start + RAM */
if (run('start')) {
  const prep = await createHotspot(cfg('big'));
  await prep.listen();
  await prep.services.embed.stop();
  fill(prep, 2000, 20, true);
  await prep.close();
  type Run = { empty: Awaited<ReturnType<typeof coldStart>>; big: Awaited<ReturnType<typeof coldStart>>; cached: Awaited<ReturnType<typeof coldStart>> };
  const runs: Run[] = [];
  await coldStart('warm', 4620, true); // füllt den Compile-Cache
  for (let i = 0; i < 3; i++) runs.push({ empty: await coldStart(`empty${i}`, 4600 + i), big: await coldStart('big', 4610 + i), cached: await coldStart(`cached${i}`, 4630 + i, true) });
  const med = (f: (r: Run) => number) => pct(runs.map(f), 0.5);
  report.push(
    `Kaltstart Browser-Modus (eigener Prozess node server/main.ts bis /api/health antwortet; Median aus 3; Mock-Ollama im Prozess):`,
    `  leerer Datenordner: ${ms(med((r) => r.empty.readyMs))}; mit Compile-Cache (wie start.bat) ${ms(med((r) => r.cached.readyMs))}; RSS bereit ${mb(med((r) => r.empty.rssReady))}, nach 3 s ${mb(med((r) => r.empty.rssLater))}`,
    `  2000 Quellen / 40 000 Abschnitte + Vektoren: ${ms(med((r) => r.big.readyMs))}; RSS bereit ${mb(med((r) => r.big.rssReady))}, nach 3 s (Vektor-Cache geladen) ${mb(med((r) => r.big.rssLater))}`,
  );
  const big = await startMeasured('big');
  await sleep(3000); // Vektor-Cache lädt nach 1,5 s im Hintergrund – Sicherung danach messen (automatische Sicherung startet erst nach 2 min)
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

/* ------------------------------------------------------------ 2) Start-Blockade + Hybrid-Suche bei 100k Abschnitten */
if (run('search')) {
  const dir = DB_DIR ? path.resolve(DB_DIR) : path.join(root, 'search');
  let built = '';
  if (!fs.existsSync(path.join(dir, 'hotspot.sqlite'))) {
    const prep = await createHotspot(cfg(dir));
    await prep.listen();
    await prep.services.embed.stop();
    const t0 = performance.now();
    fill(prep, N_SEARCH / 100, 100, true, true);
    built = `Aufbau ${((performance.now() - t0) / 1000).toFixed(1)} s; `;
    await prep.close();
  }
  // Start auf der vorhandenen DB: ab listen() Event-Loop-Verzögerung + Health-Latenz, bis Vektor-Cache (Hintergrund)
  // und Datei-GC nach 1,5 s durch sind – das ist die Zeit, in der die Oberfläche schon Anfragen schickt
  const s0 = performance.now();
  const hs = await createHotspot(cfg(dir));
  const { url } = await hs.listen();
  const tListen = performance.now() - s0;
  const { db, vectors, client } = hs.services;
  const h = { 'x-hotspot-token': hs.services.config.token };
  await fetch(url + '/api/health', { headers: h }); // erster fetch lädt undici (~50 ms, Messclient im selben Prozess)
  const eld = monitorEventLoopDelay({ resolution: 5 });
  eld.enable();
  const l0 = performance.now();
  let tLoaded = 0;
  // Anfragen wie von der Oberfläche; deren Latenz ist hier kein Maß (Client im selben Prozess startet erst nach einer Blockade)
  while (performance.now() - l0 < 60_000) {
    await fetch(url + '/api/health', { headers: h });
    if (!tLoaded && vectors.memoryBytes() > 0) tLoaded = performance.now() - l0;
    if (tLoaded && performance.now() - l0 > tLoaded + 1000) break; // GC läuft parallel und ist dann sicher durch
    await sleep(20);
  }
  eld.disable();
  report.push(
    `Start auf ${N_SEARCH.toLocaleString('de-DE')} Abschnitten (${DIM}-dim., ${built}DB ${mb(fs.statSync(path.join(dir, 'hotspot.sqlite')).size)}): createHotspot+listen ${ms(tListen)} (vor dem ersten Request; v. a. Modul-Laden),`,
    `  danach bis Vektor-Cache geladen (${(tLoaded / 1000).toFixed(1)} s nach listen, ${mb(vectors.memoryBytes())}) + 1 s: längste Event-Loop-Blockade ${ms(eld.max / 1e6)}, p99 ${ms(eld.percentile(99) / 1e6)}`,
  );
  // Suche: ROUNDS Läufe à 30 Anfragen (gleiche Begriffe bei jedem Aufruf des Skripts); synchron = Blockade je Suche
  seed = 99;
  const ftsStmt = db.prepare('SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT 40');
  const rounds: { fts: number; vec: number; hyb: number; hyb95: number }[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const queries = Array.from({ length: 30 }, () => `${queryWord()} ${queryWord()}`);
    const vec = queries.map((q) => {
      const v = Float32Array.from(fakeEmbedding(q, DIM));
      const b = performance.now();
      vectors.search(v, 40, null);
      return performance.now() - b;
    });
    const fts = queries.map((q) => {
      const b = performance.now();
      ftsStmt.all(q.toLowerCase().split(' ').map((w) => `"${w}"`).join(' OR '));
      return performance.now() - b;
    });
    const hyb: number[] = [];
    for (const q of queries) hyb.push((await hybridSearch({ db, vectors, client }, q, { limit: 10 })).tookMs);
    rounds.push({ fts: pct(fts, 0.5), vec: pct(vec, 0.5), hyb: pct(hyb, 0.5), hyb95: pct(hyb, 0.95) });
  }
  const med = (f: (x: (typeof rounds)[number]) => number) => pct(rounds.map(f), 0.5);
  report.push(
    `Suche, ${ROUNDS} Läufe à 30 Anfragen, Median der Lauf-p50 (einzelne Läufe):`,
    `  FTS5/BM25 ${ms(med((x) => x.fts))}  (${rounds.map((x) => x.fts.toFixed(0)).join(' / ')})`,
    `  Vektor int8 (Brute-Force) ${ms(med((x) => x.vec))}  (${rounds.map((x) => x.vec.toFixed(0)).join(' / ')})`,
    `  Hybrid gesamt (Query-Embedding via Mock-HTTP + FTS + Vektor + RRF) ${ms(med((x) => x.hyb))}, p95 ${ms(med((x) => x.hyb95))}  (${rounds.map((x) => x.hyb.toFixed(0)).join(' / ')})  [Schwelle ANN: p50 > 150 ms]`,
    `  Rechnerlast nach den Läufen: ${cpuLoad()}`,
  );
  await hs.close();
}

/* ------------------------------------------------------------ 3) Bibliotheksliste bei 20 000 Quellen */
if (run('list')) {
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
