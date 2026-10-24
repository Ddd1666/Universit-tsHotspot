import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { currentPlatform, download, install, type ManifestItem } from '../server/media/installer.ts';
import { makeFakeMedia, makeZip } from './fixtures.ts';
import { startTestApp, tmpDir, waitFor, waitForSource } from './helpers.ts';

/** Lokaler Fake-Download-Server (nur 127.0.0.1) mit Range-Unterstützung und steuerbaren Störungen. */
const files = new Map<string, Buffer>();
const ranges: string[] = [];
let cutNext: { path: string; after: number } | null = null;
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = files.get(req.url ?? '');
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = req.headers.range;
    if (range) ranges.push(range);
    const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
    const start = m ? Number(m[1]) : 0;
    const part = body.subarray(start);
    res.writeHead(m ? 206 : 200, { 'content-length': part.length, ...(m ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    if (cutNext && cutNext.path === req.url) {
      const after = cutNext.after;
      cutNext = null;
      res.write(part.subarray(0, after), () => res.destroy());
      return;
    }
    res.end(part);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function serve(name: string, data: Buffer, extra: Partial<ManifestItem> = {}): ManifestItem {
  files.set(`/${name}`, data);
  return { id: name.replace(/\W/g, '-'), label: name, url: `${base}/${name}`, sha256: sha(data), size: data.length, type: 'file', target: `models/${name}`, check: `models/${name}`, ...extra };
}

describe('Werkzeug-Download (SHA-256, Fortsetzen, nur tools/)', { timeout: 120_000 }, () => {
  it('ZIP: nur die genannten Dateien, flach in den Zielordner; Download-Reste werden entfernt', async () => {
    const tools = tmpDir('tools');
    const zip = makeZip({ 'pkg-1/bin/tool.exe': 'EXE', 'pkg-1/bin/helper.dll': 'DLL', 'pkg-1/doc/readme.txt': 'nicht nötig' });
    const item = serve('pkg.zip', zip, { type: 'zip', target: 'pkg', files: ['bin/tool.exe', '*.dll'], check: 'pkg/tool.exe' });
    await install(item, tools, await download(item, tools));
    expect(fs.readdirSync(path.join(tools, 'pkg')).sort()).toEqual(['helper.dll', 'tool.exe']);
    expect(fs.readdirSync(path.join(tools, '.download'))).toEqual([]);
  });

  it('abgebrochener Download wird per HTTP-Range fortgesetzt', async () => {
    const tools = tmpDir('tools');
    const data = crypto.randomBytes(300_000);
    const item = serve('gross.bin', data);
    cutNext = { path: '/gross.bin', after: 100_000 };
    ranges.length = 0;
    await expect(download(item, tools)).rejects.toMatchObject({ code: 'download_network' });
    const partSize = fs.statSync(path.join(tools, '.download', `${item.id}.part`)).size;
    expect(partSize).toBeGreaterThan(0);
    expect(partSize).toBeLessThan(data.length);
    const file = await download(item, tools);
    expect(ranges).toEqual([`bytes=${partSize}-`]);
    expect(sha(fs.readFileSync(file))).toBe(item.sha256);
  });

  it('falscher Hash: Datei wird verworfen, nichts installiert', async () => {
    const tools = tmpDir('tools');
    const item = { ...serve('boese.bin', Buffer.from('manipuliert')), sha256: 'b'.repeat(64) };
    await expect(download(item, tools)).rejects.toMatchObject({ code: 'download_hash_mismatch' });
    expect(fs.existsSync(path.join(tools, '.download', `${item.id}.part`))).toBe(false);
    expect(fs.existsSync(path.join(tools, item.target))).toBe(false);
  });

  it('Server liefert mehr als angekündigt -> Abbruch (kein unbegrenztes Schreiben)', async () => {
    const tools = tmpDir('tools');
    const item = { ...serve('zuviel.bin', Buffer.alloc(5000, 1)), size: 1000 };
    await expect(download(item, tools)).rejects.toMatchObject({ code: 'download_size_mismatch' });
  });

  it('Zip-Slip im Werkzeug-Archiv: nichts landet außerhalb von tools/', async () => {
    const tools = tmpDir('tools');
    const zip = makeZip({ '../../../evil.exe': 'böse', 'ok/tool.exe': 'x' });
    const item = serve('slip.zip', zip, { type: 'zip', target: 'slip', files: ['*.exe'], check: 'slip/tool.exe' });
    await install(item, tools, await download(item, tools)).catch(() => {});
    const parent = path.dirname(tools);
    expect(fs.readdirSync(parent).filter((f) => f.includes('evil'))).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(parent), 'evil.exe'))).toBe(false);
  });

  it('Netzwerkfehler -> verständlicher Code', async () => {
    const tools = tmpDir('tools');
    const item = { ...serve('x.bin', Buffer.from('x')), url: 'http://127.0.0.1:1/nicht-da' };
    await expect(download(item, tools)).rejects.toMatchObject({ code: 'download_network' });
  });
});

describe('scripts/setup-media.mjs (CLI)', { timeout: 120_000 }, () => {
  function cli(args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'scripts', 'setup-media.mjs'), ...args], {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.stdin.end(stdin);
      c.on('exit', (code) => resolve({ code, out }));
    });
  }

  it('zeigt Größen, fragt nach (Nein = nichts geladen), lädt nur mit Zustimmung und prüft SHA-256', async () => {
    const dir = tmpDir('cli');
    const toolsDir = path.join(dir, 'tools');
    const item = serve('cli-model.bin', crypto.randomBytes(2048), { id: 'model-small' });
    const manifest = path.join(dir, 'm.json');
    fs.writeFileSync(manifest, JSON.stringify({ version: 1, platform: currentPlatform(), items: [item] }));
    const env = { HOTSPOT_TOOLS_DIR: toolsDir, HOTSPOT_MEDIA_MANIFEST: manifest, HOTSPOT_MEDIA_ALLOW_LOCAL_HTTP: '1' };
    const status = await cli(['--status'], env);
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/\[ \] model-small/);
    const no = await cli(['model-small'], env, 'n\n');
    expect(no.out).toContain('Nichts geladen');
    expect(fs.existsSync(toolsDir)).toBe(false);
    const yes = await cli(['model-small'], env, 'j\n');
    expect(yes.code, yes.out).toBe(0);
    expect(fs.existsSync(path.join(toolsDir, item.target))).toBe(true);
    expect((await cli(['--status'], env)).out).toMatch(/\[x\] model-small/);
  });
});

describe('Einstellungen: Installation nur nach Bestätigung, danach automatische Verarbeitung', { timeout: 120_000 }, () => {
  it('ohne Bestätigung nichts; mit Bestätigung installiert; gespeicherte Medien werden verarbeitet', async () => {
    const dir = tmpDir('setup');
    const toolsDir = path.join(dir, 'tools');
    const model = Buffer.from('fake-whisper-model');
    const item = serve('ggml-small.bin', model, { id: 'model-small' });
    const manifestFile = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, platform: currentPlatform(), items: [item] }));
    const FAKE = path.join(PROJECT_ROOT, 'tests', 'fake-tools');
    const app = await startTestApp({
      toolsDir,
      mediaManifestFile: manifestFile,
      mediaAllowLocalHttp: true,
      mediaTools: { ffmpeg: [process.execPath, path.join(FAKE, 'ffmpeg.mjs')], whisper: [process.execPath, path.join(FAKE, 'whisper-cli.mjs')] },
    });
    try {
      const up = await app.upload('vorlesung.wav', makeFakeMedia('wav', { duration: 90 }));
      expect((await waitForSource(app, up.data.source.id)).statusDetail).toBe('media_tools_missing');
      const st0 = (await app.api<{ supported: boolean; items: { id: string; installed: boolean; size: number }[] }>('GET', '/api/media/status')).data;
      expect(st0.supported).toBe(true);
      expect(st0.items).toEqual([expect.objectContaining({ id: 'model-small', installed: false, size: model.length })]);

      const noConfirm = await app.api<{ error: string }>('POST', '/api/media/setup', { ids: ['model-small'] });
      expect([noConfirm.status, noConfirm.data.error]).toEqual([400, 'media_setup_confirm']);
      expect(fs.existsSync(toolsDir)).toBe(false);
      expect((await app.api<{ error: string }>('POST', '/api/media/setup', { ids: ['gibtsnicht'], confirm: true })).data.error).toBe('media_unknown_item');

      expect((await app.api('POST', '/api/media/setup', { ids: ['model-small'], confirm: true })).status).toBe(200);
      await app.hotspot.services.mediaSetup.idle();
      const st1 = (await app.api<{ items: { installed: boolean }[]; tools: { models: string[] }; setup: { error: unknown; done: string[] } }>('GET', '/api/media/status')).data;
      expect(st1.setup).toMatchObject({ error: null, done: ['model-small'] });
      expect(st1.items[0]!.installed).toBe(true);
      expect(st1.tools.models).toEqual(['small']);
      expect((await waitForSource(app, up.data.source.id, ['ready', 'error'])).status).toBe('ready');
      // alles liegt unter tools/
      expect(fs.readFileSync(path.join(toolsDir, 'models', 'ggml-small.bin'))).toEqual(model);
    } finally {
      await app.close();
    }
  });

  it('Download-Fehler wird pro Eintrag gemeldet (kein Absturz)', async () => {
    const dir = tmpDir('setup');
    const item = { ...serve('kaputt.bin', Buffer.from('a')), id: 'model-small', sha256: 'c'.repeat(64) };
    const manifestFile = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify({ version: 1, platform: currentPlatform(), items: [item] }));
    const app = await startTestApp({ toolsDir: path.join(dir, 'tools'), mediaManifestFile: manifestFile, mediaAllowLocalHttp: true });
    try {
      await app.api('POST', '/api/media/setup', { ids: ['model-small'], confirm: true });
      await app.hotspot.services.mediaSetup.idle();
      const st = (await app.api<{ setup: { running: boolean; error: { id: string; code: string } } }>('GET', '/api/media/status')).data.setup;
      expect(st).toMatchObject({ running: false, error: { id: 'model-small', code: 'download_hash_mismatch' } });
    } finally {
      await app.close();
    }
    await waitFor(() => true);
  });
});
