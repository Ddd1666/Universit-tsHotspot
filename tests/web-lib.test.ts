import { describe, expect, it } from 'vitest';
import { shouldSkipPath } from '../web/src/lib/skip.ts';
import { isServerFinal, reloadUntilFinal } from '../web/src/lib/chat-sync.ts';
import { apiErrorText } from '../web/src/lib/errors.ts';
import { translate, type TKey } from '../web/src/i18n.ts';

describe('Ordner-Import: Systemordner werden übersprungen', () => {
  it('filtert .git, node_modules, __pycache__, .venv, versteckte und Office-Sperrdateien', () => {
    for (const p of [
      'Projekt/.git/config',
      'Projekt/node_modules/react/index.js',
      'code/__pycache__/x.cpython-312.pyc',
      'code/.venv/lib/site.py',
      'code/venv/bin/activate',
      'a/.DS_Store',
      'Thumbs.db',
      'Ordner/~$Hausarbeit.docx',
      '.hidden.txt',
      'Projekt\\.git\\HEAD',
    ]) {
      expect(shouldSkipPath(p), p).toBe(true);
    }
    for (const p of ['Skript.pdf', 'Vorlesung/Folien 01.pptx', 'code/main.py', 'notizen/git-anleitung.md', 'environment/venv-hinweis.txt']) {
      expect(shouldSkipPath(p), p).toBe(false);
    }
  });
});

describe('Stopp im Chat: lokale Anzeige erst nach finalem Server-Stand verwerfen', () => {
  it('isServerFinal', () => {
    expect(isServerFinal(5, [{ id: 5, status: 'streaming' }])).toBe(false);
    expect(isServerFinal(5, [{ id: 5, status: 'aborted' }])).toBe(true);
    expect(isServerFinal(5, [])).toBe(true); // gelöscht
    expect(isServerFinal(-1, [{ id: 5, status: 'streaming' }])).toBe(true); // nie angelegt
  });

  it('reloadUntilFinal lädt nach, bis der Server "aborted" gespeichert hat', async () => {
    const states = ['streaming', 'streaming', 'aborted'];
    let calls = 0;
    const r = await reloadUntilFinal(async () => ({ messages: [{ id: 7, status: states[Math.min(calls++, 2)]! }] }), 7, { delayMs: 1 });
    expect(r.final).toBe(true);
    expect(calls).toBe(3);
    const never = await reloadUntilFinal(async () => ({ messages: [{ id: 7, status: 'streaming' }] }), 7, { delayMs: 1, attempts: 3 });
    expect(never.final).toBe(false);
  });
});

describe('Fehlertexte werden über Codes übersetzt', () => {
  const t = (lang: 'de' | 'en') => (key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
  it('übersetzt bekannte Codes inkl. Detail, fällt sonst auf die Meldung zurück', () => {
    expect(apiErrorText(t('en'), { code: 'model_missing', message: 'Embedding-Modell "bge-m3" ist nicht installiert', detail: 'bge-m3' })).toBe(
      'Model “bge-m3” is not installed. In a terminal: ollama pull bge-m3',
    );
    expect(apiErrorText(t('en'), { code: 'offline', message: 'Server nicht erreichbar' })).toBe('Server not reachable.');
    expect(apiErrorText(t('de'), { code: 'not_found', message: 'x' })).toMatch(/Nicht gefunden/);
    expect(apiErrorText(t('en'), { code: 'unbekannt', message: 'Rohtext' })).toBe('Rohtext');
  });
});
