/**
 * Nach dem Ende eines Streams (fertig, Fehler oder Stopp) darf die lokale Live-Anzeige erst verworfen werden,
 * wenn der Server die Antwort endgültig gespeichert hat – sonst "hängt" die UI mit Tipp-Punkten.
 * Rein funktional (ohne DOM), damit es getestet werden kann.
 */
export interface MinimalMessage {
  id: number;
  status: string;
}

export function isServerFinal(assistantId: number, serverMessages: MinimalMessage[]): boolean {
  if (assistantId <= 0) return true; // vor dem Anlegen abgebrochen -> nichts zu synchronisieren
  const m = serverMessages.find((x) => x.id === assistantId);
  return !m || m.status !== 'streaming'; // gelöscht oder final gespeichert
}

/** Lädt so lange neu, bis der Server-Stand final ist (max. `attempts` Versuche). */
export async function reloadUntilFinal<T extends { messages: MinimalMessage[] }>(
  load: () => Promise<T>,
  assistantId: number,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<{ data: T; final: boolean }> {
  const attempts = opts.attempts ?? 20;
  let data = await load();
  for (let i = 1; i < attempts && !isServerFinal(assistantId, data.messages); i++) {
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 250));
    data = await load();
  }
  return { data, final: isServerFinal(assistantId, data.messages) };
}
