/** Kleiner Event-Bus; wird per SSE (/api/events) an die UI weitergereicht. */
export type HubEvent =
  | { type: 'source'; source: unknown }
  | { type: 'source-deleted'; id: number }
  | { type: 'subjects' }
  | { type: 'queue'; ingest: unknown; embed: unknown }
  | { type: 'ollama'; status: unknown }
  | { type: 'chat'; session: unknown }
  | { type: 'chat-deleted'; id: number }
  | { type: 'settings'; settings: unknown };

type Listener = (e: HubEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  emit(e: HubEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* einzelner Listener darf andere nicht stören */
      }
    }
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get size(): number {
    return this.listeners.size;
  }
}
