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

  it('start.bat ruft check-deps/npm ci auf, start-browser.bat existiert, beide mit CRLF', () => {
    const bat = fs.readFileSync(path.join(PROJECT_ROOT, 'start.bat'), 'utf8');
    expect(bat).toContain('node scripts\\check-deps.mjs');
    expect(bat).toContain('call npm ci');
    expect(bat.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
    const browserBat = fs.readFileSync(path.join(PROJECT_ROOT, 'start-browser.bat'), 'utf8');
    expect(browserBat).toContain('start.bat" browser');
    expect(browserBat).toContain('\r\n');
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
