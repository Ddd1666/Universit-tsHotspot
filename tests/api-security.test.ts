import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOllamaUrl } from '../server/settings.ts';
import { startTestApp, tmpDir, waitForSource, type TestApp } from './helpers.ts';

/** Roh-Request mit frei wählbaren Headern (fetch erlaubt keinen eigenen Host-Header). */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('API-Schutz (Host, Origin, Token)', () => {
  let app: TestApp;
  beforeAll(async () => {
    const webDir = tmpDir('web');
    fs.mkdirSync(path.join(webDir, 'assets'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<meta name="hotspot-token" content="__HOTSPOT_TOKEN__">');
    fs.writeFileSync(path.join(webDir, 'assets', 'app.js'), 'console.log(1)');
    app = await startTestApp({ webDir });
  });
  afterAll(async () => app.close());

  it('bindet ausschließlich an 127.0.0.1', () => {
    const addr = app.hotspot.app.server.address();
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1');
  });

  it('blockiert fremde Host-Header (DNS-Rebinding)', async () => {
    const t = { 'x-hotspot-token': app.token };
    expect((await raw(app.port, { path: '/api/health', headers: { ...t, host: `127.0.0.1:${app.port}` } })).status).toBe(200);
    expect((await raw(app.port, { path: '/api/health', headers: { ...t, host: `localhost:${app.port}` } })).status).toBe(200);
    expect((await raw(app.port, { path: '/api/health', headers: { ...t, host: 'evil.example:80' } })).status).toBe(403);
    expect((await raw(app.port, { path: '/api/health', headers: { ...t, host: `127.0.0.1:${app.port + 1}` } })).status).toBe(403);
    // auch die Oberfläche (mit Token) wird fremden Hosts nicht ausgeliefert
    const page = await raw(app.port, { path: '/', headers: { host: 'attacker.example' } });
    expect(page.status).toBe(403);
    expect(page.body).not.toContain(app.token);
  });

  it('blockiert fremde Origins und Cross-Site-Anfragen (CSRF)', async () => {
    const base = { host: `127.0.0.1:${app.port}`, 'x-hotspot-token': app.token, 'content-type': 'application/json' };
    const evil = await raw(app.port, { method: 'POST', path: '/api/subjects', headers: { ...base, origin: 'https://evil.example' }, body: '{"name":"x","color":"#000000"}' });
    expect(evil.status).toBe(403);
    const otherPort = await raw(app.port, { method: 'POST', path: '/api/subjects', headers: { ...base, origin: 'http://127.0.0.1:8080' }, body: '{"name":"x","color":"#000000"}' });
    expect(otherPort.status).toBe(403);
    const cross = await raw(app.port, { path: '/api/subjects', headers: { ...base, 'sec-fetch-site': 'cross-site' } });
    expect(cross.status).toBe(403);
    const same = await raw(app.port, { method: 'POST', path: '/api/subjects', headers: { ...base, origin: `http://127.0.0.1:${app.port}` }, body: '{"name":"Ok","color":"#00ff00"}' });
    expect(same.status).toBe(200);
  });

  it('verlangt das Token (Header); Query-Token nur für SSE/Datei-Downloads', async () => {
    const host = `127.0.0.1:${app.port}`;
    expect((await raw(app.port, { path: '/api/subjects', headers: { host } })).status).toBe(401);
    expect((await raw(app.port, { path: '/api/subjects', headers: { host, 'x-hotspot-token': 'falsch' } })).status).toBe(401);
    expect((await raw(app.port, { path: `/api/subjects?t=${app.token}`, headers: { host } })).status).toBe(401);
    expect((await raw(app.port, { method: 'POST', path: `/api/chats?t=${app.token}`, headers: { host, 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const up = await app.upload('a.txt', 'hallo');
    expect((await raw(app.port, { path: `/api/sources/${up.data.source.id}/file?t=${app.token}`, headers: { host } })).status).toBe(200);
  });

  it('setzt Sicherheits-Header inkl. CSP und liefert Token nur in index.html', async () => {
    const r = await raw(app.port, { path: '/', headers: { host: `127.0.0.1:${app.port}` } });
    expect(r.status).toBe(200);
    expect(r.body).toContain(app.token);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('verhindert Path-Traversal bei statischen Dateien', async () => {
    const host = `127.0.0.1:${app.port}`;
    for (const p of ['/../../../etc/passwd', '/assets/../../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/..\\..\\package.json']) {
      const r = await raw(app.port, { path: p, headers: { host } });
      expect(r.body, p).not.toContain('"dependencies"');
      expect(r.body, p).not.toContain('root:');
    }
    expect((await raw(app.port, { path: '/assets/app.js', headers: { host } })).status).toBe(200);
  });

  it('liefert Uploads nie als ausführbares HTML aus', async () => {
    const up = await app.upload('xss.html', '<script>alert(document.cookie)</script><p>x</p>');
    await waitForSource(app, up.data.source.id);
    const r = await fetch(`${app.url}/api/sources/${up.data.source.id}/file?t=${app.token}`);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment;/);
    const txt = await app.upload('notiz.txt', 'Hallo');
    const r2 = await fetch(`${app.url}/api/sources/${txt.data.source.id}/file?t=${app.token}`);
    expect(r2.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(r2.headers.get('content-security-policy')).toMatch(/sandbox/);
  });

  it('validiert Eingaben (Settings, IDs, Upload-Größe)', async () => {
    expect((await app.api('PUT', '/api/settings', { numCtx: 10 })).status).toBe(400);
    expect((await app.api('PUT', '/api/settings', { ollamaUrl: 'http://api.example.com:11434' })).status).toBe(400);
    expect((await app.api('PUT', '/api/settings', { unbekannt: 1 })).status).toBe(400);
    expect((await app.api('GET', '/api/sources/abc')).status).toBe(400);
    expect((await app.api('GET', '/api/sources/999999')).status).toBe(404);
    expect((await app.api('PUT', '/api/settings', { maxFileSizeMB: 1 })).status).toBe(200);
    const big = await app.upload('gross.txt', Buffer.alloc(2 * 1024 * 1024, 65));
    expect(big.status).toBe(413);
    await app.api('PUT', '/api/settings', { maxFileSizeMB: 200 });
  });

  it('Ollama-URL: nur lokale Adressen', () => {
    expect(validateOllamaUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(validateOllamaUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(() => validateOllamaUrl('https://ollama.com')).toThrow();
    expect(() => validateOllamaUrl('http://192.168.1.5:11434')).toThrow();
    expect(() => validateOllamaUrl('http://user:pw@127.0.0.1:11434')).toThrow();
    expect(() => validateOllamaUrl('file:///etc/passwd')).toThrow();
  });
});
