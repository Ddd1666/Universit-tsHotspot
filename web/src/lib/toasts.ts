export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

/** Neue Meldung anhängen: gleicher Text ersetzt die ältere (z. B. mehrfaches „Gespeichert“), höchstens 4 sichtbar. */
export function pushToast(list: ToastItem[], t: ToastItem): ToastItem[] {
  return [...list.filter((x) => x.text !== t.text).slice(-3), t];
}
