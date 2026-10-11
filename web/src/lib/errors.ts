import type { T, TKey } from '../i18n';

/**
 * API-Fehler lokalisiert anzeigen: der Server liefert einen stabilen Code (`error`), die Oberfläche übersetzt.
 * Unbekannte Codes fallen auf die Server-Meldung zurück.
 */
export function apiErrorText(t: T, err: unknown): string {
  const e = err as { code?: string; message?: string; detail?: string };
  if (e?.code) {
    const key = `apierr.${e.code}` as TKey;
    const text = t(key, { detail: e.detail ?? '' });
    if (text !== key) return text;
  }
  return e?.message ?? String(err);
}
