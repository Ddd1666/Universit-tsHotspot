// Phase-2-Messungen (Mock-Ollama + Fake-Werkzeuge – KEINE echte Modell-/Whisper-Laufzeit):  npm run bench:media
//  1) Gescanntes PDF (40 Seiten à 1700x2200 px): Seitenbild holen + verkleinern + PNG im Worker, Event-Loop-Blockade
//  2) 3-h-Aufnahme (18 Segmente) mit Fake-ffmpeg/-whisper: reiner Pipeline-Overhead je Segment, Event-Loop-Blockade
//  3) Chunking eines 3-h-Transkripts (Satz alle 5 s) im Hauptthread
//  4) Range-Request (Player-Sprung) auf eine 50-MB-Datei: Latenz
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PROJECT_ROOT, loadConfig } from '../server/config.ts';
import { createHotspot, type Hotspot } from '../server/app.ts';
import { chunkBlocks } from '../server/ingest/chunker.ts';
import { makeFakeMedia, makeScanPdf } from '../tests/fixtures.ts';

const root = path.join(PROJECT_ROOT, '.tmp', 'bench-media');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'models'), { recursive: true });
fs.writeFileSync(path.join(root, 'models', 'ggml-small.bin'), 'fake');
const FAKE = path.join(PROJECT_ROOT, 'tests', 'fake-tools');
const report: string[] = [];
const pct = (arr: number[], p: number) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))]!;

async function app(name: string): Promise<{ hs: Hotspot; url: string; token: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  const hs = await createHotspot(
    loadConfig({
      dataDir: path.join(root, name),
      port: 0,
      token,
      mockOllama: true,
      webDir: null,
      logToFile: false,
      toolsDir: path.join(root, 'tools'),
      mediaTools: { ffmpeg: [process.execPath, path.join(FAKE, 'ffmpeg.mjs')], whisper: [process.execPath, path.join(FAKE, 'whisper-cli.mjs')], modelsDir: path.join(root, 'models') },
    }),
  );
  const { url } = await hs.listen();
  return { hs, url, token };
}

async function upload(a: { url: string; token: string }, name: string, body: Buffer): Promise<number> {
  const r = await fetch(a.url + '/api/import', { method: 'POST', headers: { 'x-hotspot-token': a.token, 'content-type': 'application/octet-stream', 'x-file-name': name }, body: new Uint8Array(body) });
  return ((await r.json()) as { source: { id: number } }).source.id;
}

async function until(fn: () => boolean): Promise<void> {
  while (!fn()) await new Promise((r) => setTimeout(r, 25));
}

/* 1) Scan-PDF */
{
  const a = await app('scan');
  const pdf = makeScanPdf(Array.from({ length: 40 }, () => ({ image: { w: 1700, h: 2200 } })));
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const id = await upload(a, 'scan40.pdf', pdf);
  await until(() => a.hs.services.library.getSource(id)?.status === 'ready' && (a.hs.services.media.counts().running === 0));
  const dt = performance.now() - t0;
  h.disable();
  report.push(`Scan-PDF 40 S. (1700x2200, ${(pdf.length / 1024 / 1024).toFixed(1)} MB): ${(dt / 1000).toFixed(1)} s gesamt ≈ ${(dt / 40).toFixed(0)} ms/Seite (ohne echte Vision-Zeit); Event-Loop max ${(h.max / 1e6).toFixed(0)} ms, p99 ${(h.percentile(99) / 1e6).toFixed(0)} ms`);
  await a.hs.close();
}

/* 2) 3-h-Aufnahme */
{
  const a = await app('audio');
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const id = await upload(a, 'vorlesung-3h.mp3', makeFakeMedia('mp3', { duration: 3 * 3600, words: ['Thermodynamik'] }));
  await until(() => ['ready', 'error'].includes(a.hs.services.library.getSource(id)?.status ?? ''));
  const dt = performance.now() - t0;
  h.disable();
  const s = a.hs.services.library.getSource(id)!;
  report.push(`3-h-Aufnahme (18 Segmente, Fake-Werkzeuge): ${(dt / 1000).toFixed(1)} s ≈ ${(dt / 18).toFixed(0)} ms Overhead/Segment (2 Prozessstarts); ${s.chunkCount} Abschnitte; Event-Loop max ${(h.max / 1e6).toFixed(0)} ms`);
  await a.hs.close();
}

/* 3) Chunking 3-h-Transkript */
{
  const blocks = Array.from({ length: 2160 }, (_, i) => ({ text: `Satz Nummer ${i} über Thermodynamik, Entropie und die Carnot-Maschine.`, loc: { kind: 'time' as const, index: i * 5, end: i * 5 + 4 }, origin: 'transcript' as const }));
  const t0 = performance.now();
  const cs = chunkBlocks(blocks);
  report.push(`Chunking 3-h-Transkript (2160 Sätze): ${(performance.now() - t0).toFixed(0)} ms -> ${cs.length} Abschnitte à ≤ 2 min`);
}

/* 4) Range-Request */
{
  const a = await app('range');
  await a.hs.services.settings.update({ mediaVideo: false });
  const big = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom\0\0\0\0isommp41', 'latin1'), crypto.randomBytes(50 * 1024 * 1024)]);
  const id = await upload(a, 'gross.mp4', big);
  const times: number[] = [];
  for (let i = 0; i < 40; i++) {
    const start = Math.floor(Math.random() * (big.length - 2e6));
    const t0 = performance.now();
    const r = await fetch(`${a.url}/api/sources/${id}/file?t=${a.token}`, { headers: { range: `bytes=${start}-${start + 1_048_575}` } });
    await r.arrayBuffer();
    times.push(performance.now() - t0);
  }
  report.push(`Range-Request 1 MB aus 50-MB-Video: p50 ${pct(times, 0.5).toFixed(1)} ms, p95 ${pct(times, 0.95).toFixed(1)} ms`);
  await a.hs.close();
}

console.log('\n' + report.join('\n'));
fs.rmSync(root, { recursive: true, force: true });
