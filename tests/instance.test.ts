import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';
import { AlreadyRunningError } from '../server/lock.ts';
import { startTestApp, tmpDir, waitFor, type TestApp } from './helpers.ts';

let apps: TestApp[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

function runCli(env: Record<string, string>, timeoutMs = 15_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(PROJECT_ROOT, 'server', 'main.ts')], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

describe('Instanz-Sperre (zweiter Start)', () => {
  it('zweite Instanz mit gleichem Datenordner bricht ab, ohne die laufende anzufassen', async () => {
    const dataDir = tmpDir('lock');
    const first = await startTestApp({ dataDir });
    apps.push(first);
    // Zustand der laufenden Instanz, den ein zweiter Start früher zerstört hätte
    const marker = path.join(dataDir, 'tmp', 'upload-in-arbeit.part');
    fs.writeFileSync(marker, 'läuft gerade');
    first.hotspot.services.db
      .prepare("INSERT INTO sources(sha256, name, size, mime, kind, status, imported_at) VALUES (?, 'x.txt', 1, 'text/plain', 'text', 'processing', 0)")
      .run('f'.repeat(64));
    first.hotspot.services.db.prepare("INSERT INTO chat_sessions(title, created_at, updated_at) VALUES ('t', 0, 0)").run();
    const sessionId = (first.hotspot.services.db.prepare('SELECT max(id) AS id FROM chat_sessions').get() as { id: number }).id;
    first.hotspot.services.db
      .prepare("INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', 'teil', 'streaming', 0)")
      .run(sessionId);

    const err = await startTestApp({ dataDir }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AlreadyRunningError);
    expect((err as AlreadyRunningError).port).toBe(first.port);
    expect(fs.existsSync(marker)).toBe(true);
    const st = first.hotspot.services.db.prepare("SELECT count(*) AS n FROM sources WHERE status = 'processing'").get() as { n: number };
    expect(st.n).toBe(1);
    const msg = first.hotspot.services.db.prepare("SELECT status FROM chat_messages WHERE content = 'teil'").get() as { status: string };
    expect(msg.status).toBe('streaming');
    expect((await first.api('GET', '/api/health')).status).toBe(200);
  });

  it('verwaiste Sperre (Prozess existiert nicht mehr) wird übernommen; Sperre wird beim Beenden entfernt', async () => {
    const dataDir = tmpDir('stale');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'hotspot.lock'), JSON.stringify({ pid: 2_147_483_000, port: 1, startedAt: 0 }));
    const app = await startTestApp({ dataDir });
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'hotspot.lock'), 'utf8')) as { pid: number; port: number };
    expect(lock).toMatchObject({ pid: process.pid, port: app.port });
    await app.close();
    expect(fs.existsSync(path.join(dataDir, 'hotspot.lock'))).toBe(false);
  });

  it('CLI: zweiter Start meldet "läuft bereits" und beendet sich mit Code 0', async () => {
    const dataDir = tmpDir('cli');
    const first = await startTestApp({ dataDir });
    apps.push(first);
    const r = await runCli({ HOTSPOT_DATA_DIR: dataDir, HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: '0' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('läuft bereits');
    expect(r.out).toContain(`127.0.0.1:${first.port}`);
    expect((await first.api('GET', '/api/health')).status).toBe(200);
  });

  it('CLI: belegter Port -> verständliche Meldung ohne Stacktrace', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const r = await runCli({ HOTSPOT_DATA_DIR: tmpDir('port'), HOTSPOT_MOCK_OLLAMA: '1', HOTSPOT_PORT: String(port) });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`Port ${port} ist belegt`);
      expect(r.out).not.toMatch(/sonic boom|at .*\.ts:\d+|Error:/);
    } finally {
      blocker.close();
    }
  });

  it('close() scheitert nicht, wenn listen() fehlschlug', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as net.AddressInfo).port;
    const { loadConfig } = await import('../server/config.ts');
    const { createHotspot } = await import('../server/app.ts');
    const dataDir = tmpDir('closefail');
    const hs = await createHotspot(loadConfig({ dataDir, port, mockOllama: true, webDir: null, logToFile: true }));
    await expect(hs.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await expect(hs.close()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, 'hotspot.lock'))).toBe(false);
    blocker.close();
    await waitFor(() => true);
  });
});
