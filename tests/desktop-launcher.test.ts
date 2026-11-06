import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { tmpDir, waitFor } from './helpers.ts';

const LAUNCHER = path.join(PROJECT_ROOT, 'scripts', 'launch-hotspot.mjs');
const WRAPPER = path.join(PROJECT_ROOT, 'scripts', 'launch-hotspot.cmd');
const NEW_SCRIPTS = ['Desktop-Icon-erstellen.bat', 'scripts/launch-hotspot.cmd', 'scripts/create-desktop-shortcut.ps1', 'start.bat'];

describe('Desktop-Icon: Dateien', () => {
  it('Skripte sind reines ASCII mit CRLF (cmd.exe/PowerShell 5.1)', () => {
    for (const f of NEW_SCRIPTS) {
      const s = fs.readFileSync(path.join(PROJECT_ROOT, f), 'utf8');
      expect([...s].every((c) => c.charCodeAt(0) < 128), f).toBe(true);
      expect(s.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')), f).toBe(true);
      expect(s.endsWith('\r\n'), f).toBe(true);
    }
  });

  it('start.bat: Modus "server" startet ohne Browser, desktop/browser unverändert', () => {
    const bat = fs.readFileSync(path.join(PROJECT_ROOT, 'start.bat'), 'utf8');
    expect(bat).toContain('set "MODE=--desktop"');
    expect(bat).toContain('if /i "%~1"=="browser" set "MODE=--browser --open"');
    expect(bat).toContain('if /i "%~1"=="server" set "MODE=--browser"\r\n');
    expect(bat.indexOf('ensure-deps.mjs')).toBeLessThan(bat.indexOf('"server"')); // Erststart: Abhängigkeiten zuerst
  });

  it('hotspot.ico: gültiges Icon mit PNG-Einträgen 16–256 px', () => {
    const b = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'hotspot.ico'));
    expect(b.readUInt16LE(0)).toBe(0);
    expect(b.readUInt16LE(2)).toBe(1); // Icon
    const n = b.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < n; i++) {
      const o = 6 + 16 * i;
      const w = b[o] || 256;
      expect(b[o + 1] || 256).toBe(w);
      const len = b.readUInt32LE(o + 8);
      const off = b.readUInt32LE(o + 12);
      expect(off + len).toBeLessThanOrEqual(b.length);
      const img = b.subarray(off, off + len);
      expect(img.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(img.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect([img.readUInt32BE(16), img.readUInt32BE(20)]).toEqual([w, w]);
      expect(img[25]).toBe(6); // RGBA
      sizes.push(w);
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });
});

/** freier Port: kurz binden, wieder freigeben */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const servers: http.Server[] = [];
const pidFiles: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const f of pidFiles.splice(0)) {
    try {
      process.kill(Number(fs.readFileSync(f, 'utf8')));
    } catch {
      /* schon beendet */
    }
  }
});

/** Server im Testprozess: Uni-Hotspot-Antwort (401 invalid_token) oder fremder Dienst */
async function fakeServer(status: number, body: string, port?: number): Promise<number> {
  const p = port ?? (await freePort());
  const s = http.createServer((_req, res) => res.writeHead(status, { 'content-type': 'application/json' }).end(body));
  servers.push(s);
  await new Promise<void>((r) => s.listen(p, '127.0.0.1', () => r()));
  return p;
}
const HOTSPOT_401 = '{"error":"invalid_token","message":"Ungültiges oder fehlendes Zugriffstoken"}';

/** Arbeitsordner mit Leerzeichen und Umlaut; Fakes protokollieren ihre Argumente neben sich (%~dp0, kein Codepage-Problem) */
function setup() {
  const dir = tmpDir('launch ü');
  const dataDir = path.join(dir, 'daten');
  const cmd = (name: string, body: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, ['@echo off', ...body.split('\n')].join('\r\n') + '\r\n');
    return f;
  };
  const chrome = cmd('chrome.cmd', 'echo %*>>"%~dp0chrome.log"');
  const opener = cmd('open.cmd', 'echo %*>>"%~dp0open.log"');
  // Fake-Server: antwortet wie Uni-Hotspot (nach FAKE_DELAY ms), beendet sich nach 20 s selbst
  fs.writeFileSync(
    path.join(dir, 'fake-server.mjs'),
    `import http from 'node:http'; import fs from 'node:fs';
     fs.writeFileSync(new URL('./server.pid', import.meta.url), String(process.pid));
     setTimeout(() => http.createServer((q, r) => r.writeHead(401).end('{"error":"invalid_token"}')).listen(Number(process.env.HOTSPOT_PORT), '127.0.0.1'), Number(process.env.FAKE_DELAY || 0));
     setTimeout(() => process.exit(0), 20000);`,
  );
  pidFiles.push(path.join(dir, 'server.pid'));
  const start = cmd('start-fake.cmd', `echo %*>>"%~dp0start.log"\n"${process.execPath}" "%~dp0fake-server.mjs"`);
  const deadStart = cmd('start-dead.cmd', 'echo %*>>"%~dp0start.log"');
  const log = (name: string) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split(/\r?\n/) : []);
  return { dir, dataDir, chrome, opener, start, deadStart, log };
}

function run(env: Record<string, string>, viaWrapper = false): Promise<{ code: number | null; out: string }> {
  const child = viaWrapper
    ? spawn('cmd.exe', ['/d', '/c', WRAPPER], { env: { ...process.env, ...env }, cwd: PROJECT_ROOT })
    : spawn(process.execPath, ['--disable-warning=ExperimentalWarning', LAUNCHER], { env: { ...process.env, ...env }, cwd: PROJECT_ROOT });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

describe.skipIf(process.platform !== 'win32')('Desktop-Icon: Launcher (Fake-Server, Fake-Chrome)', () => {
  const baseEnv = (t: ReturnType<typeof setup>, port: number) => ({
    HOTSPOT_DATA_DIR: t.dataDir,
    HOTSPOT_PORT: String(port),
    HOTSPOT_CHROME: t.chrome,
    HOTSPOT_OPEN_URL_WITH: t.opener,
    HOTSPOT_START_SCRIPT: t.deadStart,
    HOTSPOT_LAUNCH_NO_DIALOG: '1',
    HOTSPOT_LAUNCH_TIMEOUT: '3',
  });

  it('(a) läuft schon: nur Chrome --app, kein Server-Start (über launch-hotspot.cmd)', async () => {
    const t = setup();
    const port = await fakeServer(401, HOTSPOT_401);
    const r = await run(baseEnv(t, port), true);
    expect(r.code, r.out).toBe(0);
    expect(await waitFor(() => t.log('chrome.log')[0])).toBe(`--app=http://127.0.0.1:${port}`);
    expect(t.log('start.log')).toEqual([]);
    expect(t.log('open.log')).toEqual([]);
  });

  it('(b) läuft nicht: "start.bat server" (Fake) wird gestartet, danach Chrome', async () => {
    const t = setup();
    const port = await freePort();
    const r = await run({ ...baseEnv(t, port), HOTSPOT_START_SCRIPT: t.start, HOTSPOT_LAUNCH_TIMEOUT: '60' });
    expect(r.code, r.out).toBe(0);
    expect(t.log('start.log')).toEqual(['server']);
    expect(await waitFor(() => t.log('chrome.log')[0])).toBe(`--app=http://127.0.0.1:${port}`);
    expect(fs.existsSync(path.join(t.dataDir, 'launcher.lock'))).toBe(false); // Start-Sperre wieder frei
  }, 90_000);

  it('(c) ohne Chrome: Standardbrowser (Fake) mit der URL, kein --app', async () => {
    const t = setup();
    const port = await fakeServer(401, HOTSPOT_401);
    for (const chrome of ['none', path.join(t.dir, 'fehlt', 'chrome.exe')]) {
      const r = await run({ ...baseEnv(t, port), HOTSPOT_CHROME: chrome });
      expect(r.code, r.out).toBe(0);
    }
    await waitFor(() => t.log('open.log').length === 2);
    expect(t.log('open.log')).toEqual([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}`]);
    expect(t.log('chrome.log')).toEqual([]);
  });

  it('(d) Server kommt nicht hoch: Meldung mit Logdatei, Exit-Code 1, kein Browser', async () => {
    const t = setup();
    const port = await freePort();
    const r = await run({ ...baseEnv(t, port), HOTSPOT_LAUNCH_TIMEOUT: '2' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('antwortet nach 2 Sekunden nicht');
    expect(r.out).toContain(path.join(t.dataDir, 'logs', 'server.log'));
    expect(r.out).toContain('(Server) in der Taskleiste');
    expect(t.log('start.log')).toEqual(['server']);
    expect(t.log('chrome.log')).toEqual([]);
  }, 30_000);

  it.each([
    [200, '<html>anderer Dienst</html>'],
    [401, '{"error":"unauthorized"}'],
    [404, 'not found'],
  ])('(e) fremder Dienst auf dem Port (HTTP %i): Meldung, kein Chrome, kein Server-Start', async (status, body) => {
    const t = setup();
    const port = await fakeServer(status, body);
    const r = await run(baseEnv(t, port));
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Auf Port ${port} antwortet ein anderes Programm (HTTP ${status})`);
    expect(t.log('chrome.log')).toEqual([]);
    expect(t.log('start.log')).toEqual([]);
  });

  it('Port aus der Instanz-Sperre (z. B. Desktop-App mit freiem Port) hat Vorrang; HOTSPOT_PORT=0 nutzt nur die Sperre', async () => {
    const t = setup();
    const lockPort = await fakeServer(401, HOTSPOT_401);
    fs.mkdirSync(t.dataDir, { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'hotspot.lock'), JSON.stringify({ pid: process.pid, port: lockPort, startedAt: Date.now() }));
    for (const port of [await freePort(), 0]) {
      const r = await run(baseEnv(t, port));
      expect(r.code, r.out).toBe(0);
    }
    await waitFor(() => t.log('chrome.log').length === 2);
    expect(t.log('chrome.log')).toEqual([`--app=http://127.0.0.1:${lockPort}`, `--app=http://127.0.0.1:${lockPort}`]);
    expect(t.log('start.log')).toEqual([]);
  });

  it('veraltete Sperre (Port tot) stört nicht: Start über HOTSPOT_PORT', async () => {
    const t = setup();
    fs.mkdirSync(t.dataDir, { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'hotspot.lock'), JSON.stringify({ pid: 999999, port: await freePort(), startedAt: 0 }));
    const port = await freePort();
    const r = await run({ ...baseEnv(t, port), HOTSPOT_START_SCRIPT: t.start, HOTSPOT_LAUNCH_TIMEOUT: '60' });
    expect(r.code, r.out).toBe(0);
    expect(await waitFor(() => t.log('chrome.log')[0])).toBe(`--app=http://127.0.0.1:${port}`);
  }, 90_000);

  it('Doppelklick-Serie während des Starts: nur EIN Server-Start, nur EIN Chrome-Fenster', async () => {
    const t = setup();
    const port = await freePort();
    const env = { ...baseEnv(t, port), HOTSPOT_START_SCRIPT: t.start, HOTSPOT_LAUNCH_TIMEOUT: '60', FAKE_DELAY: '3000' };
    const [r1, r2, r3] = await Promise.all([run(env), run(env), run(env)]);
    for (const r of [r1, r2, r3]) expect(r.code, r.out).toBe(0);
    expect(t.log('start.log')).toEqual(['server']);
    await waitFor(() => t.log('chrome.log').length > 0);
    await new Promise((r) => setTimeout(r, 500));
    expect(t.log('chrome.log')).toEqual([`--app=http://127.0.0.1:${port}`]);
  }, 90_000);

  it('verwaiste Start-Sperre (Launcher abgestürzt) blockiert nicht', async () => {
    const t = setup();
    fs.mkdirSync(t.dataDir, { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, 'launcher.lock'), '999999');
    const port = await freePort();
    const r = await run({ ...baseEnv(t, port), HOTSPOT_START_SCRIPT: t.start, HOTSPOT_LAUNCH_TIMEOUT: '60' });
    expect(r.code, r.out).toBe(0);
    expect(t.log('start.log')).toEqual(['server']);
  }, 90_000);
});

describe.skipIf(process.platform !== 'win32')('Desktop-Icon: Verknüpfung', () => {
  const ps = (args: string[], env: Record<string, string> = {}) =>
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

  it('(f) schreibt Uni-Hotspot.lnk nach HOTSPOT_SHORTCUT_DIR, idempotent, Inhalt per WScript.Shell geprüft', () => {
    const dir = path.join(tmpDir('desktop'), 'Schreibtisch ä ö');
    fs.mkdirSync(dir);
    const script = path.join(PROJECT_ROOT, 'scripts', 'create-desktop-shortcut.ps1');
    for (let i = 0; i < 2; i++) {
      const r = ps(['-File', script], { HOTSPOT_SHORTCUT_DIR: dir });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('Uni-Hotspot.lnk');
      expect(r.stdout).toContain('loeschen');
    }
    expect(fs.readdirSync(dir)).toEqual(['Uni-Hotspot.lnk']);
    const read = ps(
      ['-Command', '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); @{ t = $s.TargetPath; a = $s.Arguments; w = $s.WorkingDirectory; i = $s.IconLocation; ws = $s.WindowStyle; d = $s.Description } | ConvertTo-Json -Compress'],
      { LNK: path.join(dir, 'Uni-Hotspot.lnk') },
    );
    expect(read.status, read.stderr).toBe(0);
    const lnk = JSON.parse(read.stdout);
    expect(lnk).toMatchObject({
      t: path.join(PROJECT_ROOT, 'scripts', 'launch-hotspot.cmd'),
      a: '',
      w: PROJECT_ROOT,
      i: path.join(PROJECT_ROOT, 'scripts', 'hotspot.ico') + ',0',
      ws: 7, // minimiert
    });
    expect(lnk.d).toContain('Chrome');
  }, 60_000);

  it('Zielordner fehlt: Fehler, nichts angelegt', () => {
    const dir = path.join(tmpDir('desktop'), 'gibt-es-nicht');
    const r = ps(['-File', path.join(PROJECT_ROOT, 'scripts', 'create-desktop-shortcut.ps1')], { HOTSPOT_SHORTCUT_DIR: dir });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  }, 60_000);
});
