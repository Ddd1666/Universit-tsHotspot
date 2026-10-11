import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { tmpDir, waitFor } from './helpers.ts';

const script = (name: string) => path.join(PROJECT_ROOT, 'scripts', name);

describe('start.bat-Logik: Abhängigkeiten nur bei geändertem package-lock.json neu installieren', () => {
  it('check-deps erkennt fehlende/veraltete Installation über den Lock-Hash', () => {
    const dir = tmpDir('deps');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":1}');
    const run = (...args: string[]) => spawnSync(process.execPath, [script('check-deps.mjs'), ...args, dir]).status;
    expect(run()).toBe(1); // noch nie installiert
    expect(run('--write')).toBe(0);
    expect(run()).toBe(0); // aktuell -> npm ci wird übersprungen
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":2}'); // Update
    expect(run()).toBe(1);
  });

  it('start.bat prüft Abhängigkeiten über ensure-deps (kein direktes npm ci), start-browser.bat existiert, beide ASCII mit CRLF', () => {
    const bat = fs.readFileSync(path.join(PROJECT_ROOT, 'start.bat'), 'utf8');
    expect(bat).toContain('node scripts\\ensure-deps.mjs');
    expect(bat).not.toMatch(/^\s*call npm ci/m); // npm ci nur nach erfolgreichem npm ping (in ensure-deps)
    expect(bat.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    expect([...bat].every((c) => c.charCodeAt(0) < 128)).toBe(true); // reines ASCII (cmd.exe-Codepage)
    const browserBat = fs.readFileSync(path.join(PROJECT_ROOT, 'start-browser.bat'), 'utf8');
    expect(browserBat).toContain('start.bat" browser');
    expect(browserBat).toContain('\r\n');
  });
});

describe('Update ohne Internet (ensure-deps vor npm ci)', () => {
  // simuliertes npm: protokolliert Aufrufe, Ergebnis von "ping"/"ci" per Umgebungsvariable
  const fakeNpm = (dir: string) => {
    const f = path.join(dir, 'fake-npm.mjs');
    fs.writeFileSync(
      f,
      `import fs from 'node:fs';
       const [cmd] = process.argv.slice(2);
       fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, cmd + '\\n');
       if (cmd === 'ci') { fs.rmSync('node_modules', { recursive: true, force: true }); if (process.env.FAKE_CI_FAIL) process.exit(1); fs.mkdirSync('node_modules/fastify', { recursive: true }); fs.writeFileSync('node_modules/fastify/package.json', '{}'); }
       process.exit(cmd === 'ping' && process.env.FAKE_OFFLINE ? 1 : 0);`,
    );
    return f;
  };
  const setup = (installed: boolean) => {
    const dir = tmpDir('deps-net');
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"v":2}');
    if (installed) {
      fs.mkdirSync(path.join(dir, 'node_modules', 'fastify'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'fastify', 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'node_modules', '.hotspot-lock-hash'), 'alter-stand');
    }
    return dir;
  };
  const run = (dir: string, env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [script('ensure-deps.mjs'), dir], { env: { ...process.env, HOTSPOT_NPM_SCRIPT: fakeNpm(dir), ...env }, encoding: 'utf8' });
    const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : [];
    return { code: r.status, out: r.stdout + r.stderr, calls };
  };

  it('offline nach Update: kein npm ci, node_modules bleibt, Start mit bisherigem Stand', () => {
    const dir = setup(true);
    const r = run(dir, { FAKE_OFFLINE: '1' });
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(['ping']);
    expect(r.out).toContain('Update braucht Internet');
    expect(fs.existsSync(path.join(dir, 'node_modules', 'fastify', 'package.json'))).toBe(true);
  });

  it('offline ohne Installation: klare Meldung, Abbruch', () => {
    const r = run(setup(false), { FAKE_OFFLINE: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('braucht Internet');
    expect(r.calls).toEqual(['ping']);
  });

  it('online: npm ci, danach Marker -> nächster Start ohne Installation', () => {
    const dir = setup(true);
    expect(run(dir).calls).toEqual(['ping', 'ci']);
    expect(run(dir).calls).toEqual(['ping', 'ci']); // Log wird fortgeschrieben, aber kein neuer Aufruf:
    const again = spawnSync(process.execPath, [script('check-deps.mjs'), dir]).status;
    expect(again).toBe(0);
  });

  it('npm ci schlägt fehl: Abbruch mit Meldung, kein Marker', () => {
    const dir = setup(true);
    const r = run(dir, { FAKE_CI_FAIL: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('npm ci ist fehlgeschlagen');
    expect(spawnSync(process.execPath, [script('check-deps.mjs'), dir]).status).toBe(1);
  });
});

describe('Sauberes Beenden über das Start-Skript', () => {
  it.skipIf(process.platform === 'win32')('Strg+C (SIGINT an die Prozessgruppe) beendet den Server geordnet (Sperrdatei entfernt)', async () => {
    const dataDir = tmpDir('shutdown');
    const port = 4300 + Math.floor(Math.random() * 400);
    const child = spawn(process.execPath, [script('start.mjs'), '--browser'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOTSPOT_DATA_DIR: dataDir, HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    const lock = path.join(dataDir, 'hotspot.lock');
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/`)).status === 200 || (await fetch(`http://127.0.0.1:${port}/`)).status === 403;
      } catch {
        return false;
      }
    }, { timeout: 60_000, interval: 200 });
    expect(fs.existsSync(lock)).toBe(true);
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    process.kill(-child.pid!, 'SIGINT'); // wie Strg+C im Terminal: ganze Gruppe
    const code = await exited;
    expect(code).toBe(0);
    await waitFor(() => !fs.existsSync(lock), { timeout: 10_000 });
  }, 90_000);

  it.skipIf(process.platform === 'win32')('sehr frühes Strg+C (noch während des Starts) hinterlässt keine Sperrdatei', async () => {
    const dataDir = tmpDir('shutdown-early');
    const port = 4700 + Math.floor(Math.random() * 200);
    const child = spawn(process.execPath, [script('start.mjs'), '--browser'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, HOTSPOT_DATA_DIR: dataDir, HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    const lock = path.join(dataDir, 'hotspot.lock');
    await waitFor(() => fs.existsSync(lock), { timeout: 60_000, interval: 2 }); // Start läuft gerade
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    process.kill(-child.pid!, 'SIGINT');
    expect(await exited).toBe(0);
    await waitFor(() => !fs.existsSync(lock), { timeout: 10_000 });
  }, 90_000);
});
