import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_ROOT } from '../server/config.ts';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

describe('Übersetzungen für Server-Fehlercodes (EN-Oberfläche ohne deutsche Servertexte)', () => {
  const i18n = fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'src', 'i18n.ts'), 'utf8');
  const server = walk(path.join(PROJECT_ROOT, 'server'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');

  it('jeder HttpError-/deny-Code hat einen deutschen und englischen Text', () => {
    const codes = new Set<string>();
    for (const m of server.matchAll(/HttpError\(\d+, '([a-z_]+)'/g)) codes.add(m[1]!);
    for (const m of server.matchAll(/deny\(reply, \d+, '([a-z_]+)'/g)) codes.add(m[1]!);
    for (const m of server.matchAll(/send\(\{ error: '([a-z_]+)'/g)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThan(15);
    for (const code of codes) {
      const n = i18n.split(`'apierr.${code}':`).length - 1;
      expect(n, code).toBe(2);
    }
  });

  it('Extraktions-Fehlercodes haben Texte (detail.*)', () => {
    const codes = new Set<string>();
    for (const m of server.matchAll(/code: '((?:pdf|extract|zip)_[a-z_]+)'/g)) codes.add(m[1]!);
    for (const m of server.matchAll(/'(zip_(?:unsafe_path|limits|bomb|invalid))'/g)) codes.add(m[1]!);
    for (const m of server.matchAll(/codedError\([^;]*?, '([a-z_]+)'/g)) codes.add(m[1]!);
    for (const m of server.matchAll(/coded\('[^']*', '([a-z_]+)'\)/g)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThanOrEqual(9);
    expect(codes).toContain('office_corrupt');
    expect(codes).toContain('no_extractor');
    for (const code of codes) expect(i18n.split(`'detail.${code}':`).length - 1, code).toBe(2);
  });

  it('Phase 2: alle Medien-/Vision-/Download-Codes (Status-Details, Job-Fehler) haben DE+EN', () => {
    const files = [...walk(path.join(PROJECT_ROOT, 'server', 'media')), path.join(PROJECT_ROOT, 'server', 'ingest', 'detect.ts'), path.join(PROJECT_ROOT, 'server', 'ingest', 'ingest.ts')];
    const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const codes = new Set<string>();
    for (const m of src.matchAll(/'((?:media|vision|image|download|ocr)_[a-z_]+)'/g)) codes.add(m[1]!);
    expect(codes.size).toBeGreaterThan(25);
    for (const c of ['media_disabled', 'media_tools_missing', 'media_mismatch', 'image_format_unsupported', 'ocr_empty', 'media_failed', 'download_hash_mismatch']) expect(codes).toContain(c);
    for (const code of codes) {
      const key = src.includes(`HttpError(`) && new RegExp(`HttpError\\(\\d+, '${code}'`).test(src) ? 'apierr' : 'detail';
      expect(i18n.split(`'${key}.${code}':`).length - 1, code).toBe(2);
    }
    // Job-Zustände/-Arten und Quellstatus "media" werden übersetzt
    for (const k of ['queued', 'running', 'done', 'error', 'cancelled']) expect(i18n.split(`'queue.state.${k}':`).length - 1, k).toBe(2);
    for (const k of ['image', 'scan', 'audio', 'video']) expect(i18n.split(`'queue.kind.${k}':`).length - 1, k).toBe(2);
    expect(i18n.split(`'status.media':`).length - 1).toBe(2);
  });

  it('Phase 3: Lern-Codes (Job-Fehler, API-Fehler), Job-Arten, Stufen, Karten-/Fragetypen haben DE+EN', () => {
    const src = walk(path.join(PROJECT_ROOT, 'server', 'learn'))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');
    const detail = new Set<string>();
    for (const m of src.matchAll(/codedError\([^;]*?, '([a-z_]+)'/g)) detail.add(m[1]!);
    expect(detail.size).toBeGreaterThanOrEqual(6);
    detail.add('learn_failed'); // Fallback-Code für unbekannte Fehler
    detail.add('learn_scope_missing'); // Bereich gelöscht, während der Job wartete
    for (const code of detail) expect(i18n.split(`'detail.${code}':`).length - 1, code).toBe(2);
    const api = new Set([...src.matchAll(/HttpError\(\d+, '([a-z_]+)'/g)].map((m) => m[1]!));
    expect(api.size).toBeGreaterThan(10);
    for (const code of api) expect(i18n.split(`'apierr.${code}':`).length - 1, code).toBe(2);
    const keys = [
      ...['summary', 'cards', 'quiz', 'graph'].flatMap((k) => [`queue.kind.${k}`, `gen.kind.${k}`]),
      ...['tldr', 'outline', 'detailed', 'cheatsheet'].map((k) => `level.${k}`),
      ...['qa', 'cloze', 'image'].map((k) => `cards.type.${k}`),
      ...['mc', 'tf', 'cloze', 'short'].map((k) => `quiz.type.${k}`),
      ...['draft', 'active', 'suspended'].map((k) => `cards.${k}`),
      ...['review', 'cards', 'quiz', 'notes', 'graph', 'stats'].map((k) => `learn.tab.${k}`),
    ];
    for (const k of keys) expect(i18n.split(`'${k}':`).length - 1, k).toBe(2);
  });

  it('K4: Download/Installation meldet nur feste Codes – rohe Node-Codes (EPERM, ENOSPC …) werden abgebildet', async () => {
    const { SETUP_ERROR_CODES, setupErrorCode } = await import('../server/media/installer.ts');
    for (const code of SETUP_ERROR_CODES) expect(i18n.split(`'detail.${code}':`).length - 1, code).toBe(2);
    expect(setupErrorCode(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('download_install_failed');
    expect(setupErrorCode(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('download_disk_full');
    expect(setupErrorCode(new Error('ohne Code'))).toBe('download_install_failed');
    expect(setupErrorCode(Object.assign(new Error('x'), { code: 'download_hash_mismatch' }))).toBe('download_hash_mismatch');
    // die Kommandozeile hat für jeden Code einen Hinweis
    const cli = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'setup-media.mjs'), 'utf8');
    for (const code of SETUP_ERROR_CODES) expect(cli, code).toContain(`  ${code}: '`);
  });

  it('Extraktion wirft keine Fehler ohne Code (sonst landet deutscher Text in der EN-Oberfläche)', () => {
    const dir = path.join(PROJECT_ROOT, 'server', 'ingest');
    const files = [...walk(path.join(dir, 'extractors')), path.join(dir, 'extract-run.ts')];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src.match(/throw new Error\(/g) ?? [], path.basename(f)).toEqual([]);
    }
  });

  it('Phase 4: Wörterbücher vollständig – gleiche Schlüssel, gleiche Platzhalter, nichts leer, EN ohne deutsche Umlaute', async () => {
    const { DICTS } = await import('../web/src/i18n.ts');
    const de = DICTS.de as Record<string, string>;
    const en = DICTS.en as Record<string, string>;
    expect(Object.keys(en).sort()).toEqual(Object.keys(de).sort());
    // {name} = Platzhalter; {{…}} = Lückentext-Beispiel (bleibt übersetzbar)
    const vars = (s: string) => [...s.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(de)) {
      expect(de[k]!.trim(), `DE leer: ${k}`).not.toBe('');
      expect(en[k]!.trim(), `EN leer: ${k}`).not.toBe('');
      expect(vars(en[k]!), `Platzhalter ${k}`).toEqual(vars(de[k]!));
      expect(en[k], `deutscher Text in EN: ${k}`).not.toMatch(/[äöüÄÖÜß]/);
    }
  });

  it('Phase 4: jeder in der Oberfläche benutzte Schlüssel existiert (t("…") und t(`präfix.${…}`))', async () => {
    const { DICTS } = await import('../web/src/i18n.ts');
    const keys = Object.keys(DICTS.de);
    const web = walk(path.join(PROJECT_ROOT, 'web', 'src')).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('i18n.ts'));
    let literal = 0;
    for (const f of web) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-z][\w.-]*)'/g)) {
        literal++;
        expect(keys, `${path.basename(f)}: ${m[1]}`).toContain(m[1]);
      }
      for (const m of src.matchAll(/\bt\(\s*`([a-z][\w.-]*\.)\$\{/g)) expect(keys.some((k) => k.startsWith(m[1]!)), `${path.basename(f)}: ${m[1]}…`).toBe(true);
    }
    expect(literal).toBeGreaterThan(500);
    // neue Ansichten nutzen ausschließlich übersetzte Texte für Beschriftungen
    for (const f of ['views/BackupView.tsx', 'views/DiagnosticsView.tsx', 'components/Wizard.tsx', 'components/ErrorBoundary.tsx']) {
      const src = fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'src', f), 'utf8');
      expect(src.match(/aria-label="[^"]*[a-zäöü]{3}[^"]*"/g) ?? [], f).toEqual([]);
    }
  });

  it('Electron-Dialoge: keine fest verdrahteten deutschen Texte, DE/EN vollständig', () => {
    const main = fs.readFileSync(path.join(PROJECT_ROOT, 'electron', 'main.ts'), 'utf8');
    for (const m of main.matchAll(/dialog\.show\w+\(([^;]*)/g)) expect(m[1], m[0]).not.toMatch(/['"`][^'"`]*[äöüßÄÖÜ][^'"`]*['"`]/);
    const msgs = fs.readFileSync(path.join(PROJECT_ROOT, 'electron', 'messages.ts'), 'utf8');
    const keys = (lang: string) => [...msgs.slice(msgs.indexOf(`  ${lang}: {`)).split('\n  },')[0]!.matchAll(/^ {4}(\w+):/gm)].map((x) => x[1]).sort();
    expect(keys('de').length).toBeGreaterThan(5);
    expect(keys('en')).toEqual(keys('de'));
  });
});
