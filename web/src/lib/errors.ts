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

/** Fehlermeldung eines Ollama-/API-Fehlers lokalisiert aufbereiten. */
export function errorText(t: T, err: { code?: string; message: string; detail?: string }, model?: string): string {
  switch (err.code) {
    case 'unreachable':
    case 'ollama_unreachable':
      return t('err.unreachable');
    case 'model_missing':
      return t('err.model_missing', { model: model ?? err.detail ?? '<model>' });
    case 'oom':
      return t('err.oom');
    case 'timeout':
      return t('err.timeout');
    default:
      // bekannte API-Codes (z. B. empty, nothing_to_regenerate) übersetzt, sonst die Meldung (z. B. von Ollama)
      return t('err.generic', { message: apiErrorText(t, err) });
  }
}
