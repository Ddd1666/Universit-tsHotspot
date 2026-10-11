import { describe, expect, it } from 'vitest';
import { shouldSkipPath } from '../web/src/lib/skip.ts';
import { isServerFinal, reloadUntilFinal } from '../web/src/lib/chat-sync.ts';
import { apiErrorText, errorText } from '../web/src/lib/errors.ts';
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

describe('Chat- und Importfehler in der Oberflächensprache', () => {
  const t = (lang: 'de' | 'en') => (key: TKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
  it('Chat: empty / nothing_to_regenerate / too_large werden übersetzt statt deutscher Servertext', () => {
    expect(errorText(t('en'), { code: 'empty', message: 'Nachricht ist leer' })).toBe('Error: Message is empty.');
    expect(errorText(t('en'), { code: 'nothing_to_regenerate', message: 'Keine Frage zum Neu-Generieren' })).toBe('Error: No question to regenerate.');
    expect(errorText(t('en'), { code: 'unreachable', message: 'x' })).toMatch(/^Ollama is not reachable/);
    // unbekannter Code (z. B. Ollama-HTTP-Fehler): Originalmeldung
    expect(errorText(t('en'), { code: 'http', message: 'model requires more system memory' })).toBe('Error: model requires more system memory');
  });
  it('Import: Größenlimit mit Zahl aus dem Server-Detail', () => {
    expect(apiErrorText(t('en'), { code: 'too_large', message: 'Datei überschreitet das Limit von 200 MB', detail: '200' })).toBe(
      'File exceeds the limit of 200 MB (can be changed in the settings).',
    );
    expect(apiErrorText(t('de'), { code: 'too_large', message: '…', detail: '200' })).toMatch(/200 MB/);
  });
});


describe('Kosmetik: Größen, Status-Badge, Modellauswahl, Token', () => {
  it('Größen mit Dezimaltrennzeichen der Oberflächensprache', async () => {
    const { formatBytes } = await import('../web/src/lib/format.ts');
    expect(formatBytes(1741, 'de')).toBe('1,7 KB');
    expect(formatBytes(1741, 'en')).toBe('1.7 KB');
    expect(formatBytes(250 * 1024 * 1024, 'de')).toBe('250 MB');
    expect(formatBytes(512, 'de')).toBe('512 B');
  });

  it('gekürzt indexierte Datei: Warnfarbe und "teilweise indexiert (gekürzt)" statt grün "indexiert"', async () => {
    const { sourceBadge } = await import('../web/src/lib/status.ts');
    const base = { status: 'ready' as const, chunkCount: 10, embeddedCount: 10 };
    expect(sourceBadge({ ...base, statusDetail: 'truncated_text' })).toEqual({ key: 'status.partial', cls: 'warn' });
    expect(sourceBadge({ ...base, statusDetail: 'partial_text,truncated' }).key).toBe('status.partial');
    expect(sourceBadge({ ...base, statusDetail: null })).toEqual({ key: 'status.ready', cls: 'ok' });
    expect(sourceBadge({ ...base, embeddedCount: 3, statusDetail: null }).key).toBe('status.embedPending');
    expect(translate('de', 'status.partial')).toBe('teilweise indexiert (gekürzt)');
    expect(translate('en', 'status.partial')).toBe('partially indexed (truncated)');
  });

  it('Embedding-Auswahl: jedes Modell genau einmal (bge-m3 gewählt, aber nicht installiert)', async () => {
    const { embeddingChoices } = await import('../web/src/lib/status.ts');
    const c = embeddingChoices(['nomic-embed-text:latest', 'all-minilm:latest'], 'bge-m3');
    expect(c.map((x) => x.value)).toEqual(['bge-m3', 'nomic-embed-text', 'all-minilm']);
    expect(c[0]).toEqual({ value: 'bge-m3', installed: false });
    const d = embeddingChoices(['nomic-embed-text:latest', 'bge-m3:latest'], 'nomic-embed-text');
    expect(d.map((x) => x.value)).toEqual(['nomic-embed-text', 'bge-m3']);
    expect(d.every((x) => x.installed)).toBe(true);
  });

  it('"Token" ist übersetzt', () => {
    expect(translate('en', 'set.tokens', { n: '8,192' })).toBe('8,192 tokens');
    expect(translate('de', 'set.tokens', { n: '8.192' })).toBe('8.192 Token');
  });
});
