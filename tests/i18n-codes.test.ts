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

  it('Extraktion wirft keine Fehler ohne Code (sonst landet deutscher Text in der EN-Oberfläche)', () => {
    const dir = path.join(PROJECT_ROOT, 'server', 'ingest');
    const files = [...walk(path.join(dir, 'extractors')), path.join(dir, 'extract-run.ts')];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src.match(/throw new Error\(/g) ?? [], path.basename(f)).toEqual([]);
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
