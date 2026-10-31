import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Texte der nativen Electron-Dialoge – in der Sprache der Oberfläche (Einstellung), sonst nach OS-Sprache. */
export type DialogLang = 'de' | 'en';

export const DIALOG_TEXT = {
  de: {
    notBuilt: 'Die Weboberfläche ist nicht gebaut. Bitte „npm run build“ ausführen bzw. start.bat erneut starten.',
    alreadyRunning: 'Uni-Hotspot läuft bereits (gleicher Datenordner).',
    reachableAt: (url: string) => `Die laufende Instanz ist erreichbar unter ${url}.`,
    staleLockHint: (file: string) => `Falls sicher keine Instanz läuft: diese Sperrdatei löschen und neu starten:\n${file}`,
    openInBrowser: 'Im Browser öffnen',
    close: 'Schließen',
    startErrorTitle: 'Uni-Hotspot – Startfehler',
    crashed: 'Die Oberfläche ist unerwartet beendet worden. Deine Daten sind gespeichert.',
    reload: 'Neu laden',
    quit: 'Beenden',
    restartFailed: 'Neustart nach der Wiederherstellung fehlgeschlagen. Bitte Uni-Hotspot neu starten.',
    fatal: 'Uni-Hotspot wurde nach einem internen Fehler geordnet beendet. Deine Daten sind gespeichert. Details: Einstellungen → Diagnose → Bericht.',
  },
  en: {
    notBuilt: 'The web interface has not been built. Please run “npm run build” or start start.bat again.',
    alreadyRunning: 'Uni-Hotspot is already running (same data folder).',
    reachableAt: (url: string) => `The running instance is available at ${url}.`,
    staleLockHint: (file: string) => `If you are sure no instance is running: delete this lock file and start again:\n${file}`,
    openInBrowser: 'Open in browser',
    close: 'Close',
    startErrorTitle: 'Uni-Hotspot – startup error',
    crashed: 'The interface stopped unexpectedly. Your data is saved.',
    reload: 'Reload',
    quit: 'Quit',
    restartFailed: 'Restart after restoring failed. Please start Uni-Hotspot again.',
    fatal: 'Uni-Hotspot was shut down after an internal error. Your data is saved. Details: Settings → Diagnostics → report.',
  },
} satisfies Record<DialogLang, Record<string, unknown>>;

/** Sprache aus der Einstellung „language“ (nur lesend, auch während eine andere Instanz läuft), sonst OS-Locale. */
export function dialogLanguage(dataDir: string, osLocale: string): DialogLang {
  try {
    const db = new DatabaseSync(path.join(dataDir, 'hotspot.sqlite'), { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'language'").get() as { value: string } | undefined;
      const v: unknown = row ? JSON.parse(row.value) : null;
      if (v === 'de' || v === 'en') return v;
    } finally {
      db.close();
    }
  } catch {
    /* noch keine Datenbank (erster Start) oder nicht lesbar */
  }
  return osLocale.toLowerCase().startsWith('de') ? 'de' : 'en';
}
