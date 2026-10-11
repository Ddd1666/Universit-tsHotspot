import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DIALOG_TEXT, dialogLanguage } from '../electron/messages.ts';
import { tmpDir } from './helpers.ts';

describe('Electron-Dialoge in der Oberflächensprache', () => {
  it('ohne Datenbank: OS-Sprache entscheidet', () => {
    const dir = tmpDir('dlg');
    expect(dialogLanguage(dir, 'de-DE')).toBe('de');
    expect(dialogLanguage(dir, 'en-US')).toBe('en');
    expect(dialogLanguage(dir, 'fr')).toBe('en');
  });

  it('gespeicherte Spracheinstellung hat Vorrang vor der OS-Sprache', () => {
    const dir = tmpDir('dlg-db');
    const db = new DatabaseSync(path.join(dir, 'hotspot.sqlite'));
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('language', JSON.stringify('en'));
    db.close();
    expect(dialogLanguage(dir, 'de-DE')).toBe('en');
    expect(DIALOG_TEXT.en.alreadyRunning).toMatch(/already running/);
    expect(DIALOG_TEXT.en.staleLockHint('C:\\x\\hotspot.lock')).toContain('hotspot.lock');
  });
});
