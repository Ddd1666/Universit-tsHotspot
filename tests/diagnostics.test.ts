import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RotatingLog, redactText, sanitizeLogLines } from '../server/logs.ts';
import { startTestApp, tmpDir, waitFor, waitForSource, type TestApp } from './helpers.ts';

const open: TestApp[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const a of open.splice(0)) await a.close().catch(() => {});
});

describe('Log-Rotation', () => {
  it('rotiert im laufenden Betrieb und hält höchstens N alte Dateien', () => {
    const dir = tmpDir('log');
    const file = path.join(dir, 'server.log');
    const log = new RotatingLog(file, { maxBytes: 1000, keep: 2 });
    for (let i = 0; i < 60; i++) log.write(`${JSON.stringify({ i, msg: 'x'.repeat(80) })}\n`);
    log.end();
    expect(fs.readdirSync(dir).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).size).toBeLessThan(1200);
    // jüngste Zeile steht in server.log
    expect(fs.readFileSync(file, 'utf8')).toContain('"i":59');
  });

  it('rotiert beim Start, wenn die Datei schon zu groß ist', () => {
    const dir = tmpDir('log2');
    const file = path.join(dir, 'server.log');
    fs.writeFileSync(file, 'a'.repeat(5000));
    const log = new RotatingLog(file, { maxBytes: 1000 });
    log.write('neu\n');
    log.end();
    expect(fs.readFileSync(file, 'utf8')).toBe('neu\n');
    expect(fs.statSync(file + '.1').size).toBe(5000);
  });

  it('App schreibt über das rotierende Ziel (kleines Limit)', async () => {
    const a = await startTestApp({ logToFile: true, logMaxBytes: 600 });
    open.push(a);
    for (let i = 0; i < 20; i++) a.hotspot.app.log.info(`Zeile ${i} ${'y'.repeat(60)}`);
    expect(fs.existsSync(path.join(a.dataDir, 'logs', 'server.log.1'))).toBe(true);
  });
});

describe('Diagnose und Log-Export ohne Inhalte der Nutzerdokumente', () => {
  it('Bereinigung: Benutzerpfade, Token, Text in Anführungszeichen, Zusatzdaten, Fehlermeldungen', () => {
    const home = os.homedir();
    expect(redactText(`${home}\\Uni-Hotspot-Daten\\x`)).not.toContain(home);
    expect(redactText('C:\\Users\\Max Mustermann\\Daten')).toBe('C:\\Users\\<USER>\\Daten');
    expect(redactText('/api/events?t=abc123&x=1')).toBe('/api/events?t=<TOKEN>&x=1');
    const raw = [
      JSON.stringify({ level: 30, time: 1, msg: 'Verarbeitung fehlgeschlagen: "Geheim.pdf" in „Ordner“', extra: 'GEHEIMINHALT' }),
      JSON.stringify({ level: 50, time: 2, msg: 'boom', err: { type: 'Error', message: 'GEHEIMINHALT', code: 'EPERM', stack: 'Error: GEHEIMINHALT\n    at f (C:\\Users\\Max\\app\\x.ts:1:1)' } }),
      'keine JSON-Zeile GEHEIMINHALT',
    ].join('\n');
    const out = sanitizeLogLines(raw).join('\n');
    expect(out).not.toMatch(/GEHEIM|Geheim|Ordner|Max/);
    expect(out).toContain('Verarbeitung fehlgeschlagen');
    expect(out).toContain('[Error EPERM]');
    expect(out).toContain('at f (C:\\Users\\<USER>');
  });

  it('API liefert Versionen/Status/Größen; Bericht enthält weder Dokumentinhalt noch Dateinamen noch Token', async () => {
    const a = await startTestApp({ logToFile: true });
    open.push(a);
    const ok = (await a.upload('GEHEIMNAME-Skript.md', '# Kapitel\n\nGEHEIMINHALT steht nur im Dokument.')).data.source;
    const bad = (await a.upload('GEHEIMNAME-kaputt.pdf', '%PDF-1.4\nGEHEIMINHALT kaputt')).data.source;
    await waitForSource(a, ok.id);
    await waitForSource(a, bad.id);
    await a.api('GET', '/api/search?q=GEHEIMINHALT');
    await a.api('POST', '/api/notes', { title: 'GEHEIMNAME Notiz', body: 'GEHEIMINHALT' });
    a.hotspot.app.log.error(new Error('Fehler mit GEHEIMINHALT'));
    a.hotspot.app.log.info({ extra: { text: 'GEHEIMINHALT' } }, 'Meldung zu "GEHEIMNAME.pdf"');
    await waitFor(() => fs.readFileSync(path.join(a.dataDir, 'logs', 'server.log'), 'utf8').includes('Meldung zu'), { message: 'log' });

    const d = (await a.api<Record<string, Record<string, unknown>>>('GET', '/api/diagnostics')).data;
    expect(d.app).toMatchObject({ schema: 4, mock: true });
    expect(typeof d.app!.node).toBe('string');
    expect(d.dataDir).toMatchObject({ writable: true });
    expect((d.dataDir!.sizes as { db: number }).db).toBeGreaterThan(0);
    expect((d.ollama!.required as { roles: string[] }[]).map((r) => r.roles.join('+'))).toEqual(['chat+vision', 'embedding']); // gemma3:4b nur einmal
    expect(d.counts).toMatchObject({ sources: 2 });
    expect(JSON.stringify(d)).not.toMatch(/GEHEIM/);

    const r = await fetch(`${a.url}/api/diagnostics/report`, { headers: { 'x-hotspot-token': a.token } });
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="Uni-Hotspot-Diagnose-/);
    const text = await r.text();
    expect(text).toContain('Uni-Hotspot Diagnose');
    expect(text).toContain('Verarbeitung fehlgeschlagen: Quelle #'); // Log-Zeilen sind enthalten …
    expect(text).not.toMatch(/GEHEIM/); // … aber keine Inhalte/Dateinamen
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(os.homedir());
  });
});

describe('Korrekturrunde 1: Diagnose ohne Dateinamen, Altformat-Logs, Benutzername, Rotation', () => {
  it('K5/T11: laufende Verarbeitung (Dateiname), Altformat-Logzeile ohne Anführungszeichen, Benutzername außerhalb von \\Users\\ – nichts davon im Bericht', async () => {
    const a = await startTestApp({ logToFile: true });
    open.push(a);
    const user = os.userInfo().username;
    const svc = a.hotspot.services;
    // Zustand „wird gerade verarbeitet“ mit Dateiname (deterministisch statt zeitabhängig)
    const orig = svc.ingest.stats.bind(svc.ingest);
    svc.ingest.stats = () => ({ ...orig(), processing: [{ id: 7, name: 'GEHEIMNAME-laeuft.pdf' }] });
    const log = path.join(a.dataDir, 'logs', 'server.log');
    fs.appendFileSync(log, JSON.stringify({ level: 30, time: Date.now(), msg: 'Verarbeitung fehlgeschlagen: GEHEIMNAME-alt.pdf' }) + '\n');
    fs.appendFileSync(log, JSON.stringify({ level: 30, time: Date.now(), msg: `Datenordner D:\\${user}-daten verschoben` }) + '\n');
    const diag = (await a.api<Record<string, unknown>>('GET', '/api/diagnostics')).data;
    expect(JSON.stringify(diag)).not.toMatch(/GEHEIMNAME/);
    expect((diag.queue as { ingest: { processing: number } }).ingest.processing).toBe(1);
    const text = await (await fetch(`${a.url}/api/diagnostics/report`, { headers: { 'x-hotspot-token': a.token } })).text();
    expect(text).not.toMatch(/GEHEIMNAME/);
    expect(text).toContain('Verarbeitung fehlgeschlagen: …');
    if (user.length >= 3) expect(text.toLowerCase()).not.toContain(user.toLowerCase());
  });

  it('K10 (Runde 2): Benutzername „uni“ wird nur in Pfaden ersetzt – „Uni-Hotspot“ und andere Wörter bleiben heil', () => {
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'uni', uid: -1, gid: -1, shell: null, homedir: os.homedir() });
    const out = redactText('Uni-Hotspot gestartet, Universität ok; Daten D:\\uni\\daten und E:\\uni-sicherung\\x sowie /mnt/uni/y');
    expect(out).toContain('Uni-Hotspot gestartet, Universität ok');
    expect(out).toContain('D:\\<USER>\\daten');
    expect(out).toContain('E:\\<USER>-sicherung\\x');
    expect(out).toContain('/mnt/<USER>/y');
  });

  it('T8: Rotation scheitert (Datei nicht umbenennbar) -> Historie bleibt unverändert, kein Versuch je Zeile', () => {
    const dir = tmpDir('logrot');
    const file = path.join(dir, 'server.log');
    fs.writeFileSync(file + '.1', 'ALT-1');
    fs.writeFileSync(file + '.2', 'ALT-2');
    fs.mkdirSync(file + '.rotating'); // Umbenennen auf diesen Namen scheitert
    const log = new RotatingLog(file, { maxBytes: 500, keep: 3 });
    const spy = vi.spyOn(fs, 'renameSync');
    for (let i = 0; i < 40; i++) log.write('x'.repeat(99) + '\n');
    log.end();
    expect(fs.readFileSync(file + '.1', 'utf8')).toBe('ALT-1');
    expect(fs.readFileSync(file + '.2', 'utf8')).toBe('ALT-2');
    expect(spy.mock.calls.length).toBeLessThanOrEqual(8); // höchstens ein Versuch je 500 Byte, nicht je Zeile
    expect(fs.statSync(file).size).toBe(4000); // nichts verloren
  });
});