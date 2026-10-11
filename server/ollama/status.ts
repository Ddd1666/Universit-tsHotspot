import type { OllamaClient } from './client.ts';

export interface OllamaStatus {
  reachable: boolean;
  url: string;
  mock: boolean;
  version: string | null;
  models: { name: string; size: number; family: string | null; parameterSize: string | null; quantization: string | null }[];
  running: { name: string; size: number; sizeVram: number; gpuPercent: number; contextLength: number | null; expiresAt: string | null }[];
  error: string | null;
  checkedAt: number;
}

/** Pollt Ollama (Version, installierte Modelle, Modelle im VRAM) und meldet Änderungen. */
export class OllamaMonitor {
  private current: OllamaStatus;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<OllamaStatus> | null = null;
  private readonly client: OllamaClient;
  private readonly mock: boolean;
  private readonly onChange: (s: OllamaStatus, cameOnline: boolean) => void;

  constructor(client: OllamaClient, mock: boolean, onChange: (s: OllamaStatus, cameOnline: boolean) => void) {
    this.client = client;
    this.mock = mock;
    this.onChange = onChange;
    this.current = { reachable: false, url: client.baseUrl, mock, version: null, models: [], running: [], error: null, checkedAt: 0 };
  }

  get status(): OllamaStatus {
    return this.current;
  }

  start(intervalMs = 15_000): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refresh(): Promise<OllamaStatus> {
    if (this.inflight) return this.inflight;
    this.inflight = this.check().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async check(): Promise<OllamaStatus> {
    const prev = this.current;
    let next: OllamaStatus;
    try {
      const version = await this.client.version();
      const [models, running] = await Promise.all([this.client.tags(), this.client.ps().catch(() => [])]);
      next = {
        reachable: true,
        url: this.client.baseUrl,
        mock: this.mock,
        version,
        models: models
          .map((m) => ({
            name: m.name,
            size: m.size,
            family: m.details?.family ?? null,
            parameterSize: m.details?.parameter_size ?? null,
            quantization: m.details?.quantization_level ?? null,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        running: running.map((r) => ({
          name: r.name,
          size: r.size,
          sizeVram: r.size_vram,
          gpuPercent: r.size ? Math.round((r.size_vram / r.size) * 100) : 0,
          contextLength: r.context_length ?? null,
          expiresAt: r.expires_at ?? null,
        })),
        error: null,
        checkedAt: Date.now(),
      };
    } catch (err) {
      next = { ...prev, reachable: false, url: this.client.baseUrl, running: [], error: (err as Error).message, checkedAt: Date.now() };
    }
    this.current = next;
    const changed =
      prev.reachable !== next.reachable ||
      prev.error !== next.error ||
      JSON.stringify(prev.models) !== JSON.stringify(next.models) ||
      JSON.stringify(prev.running.map((r) => [r.name, r.sizeVram])) !== JSON.stringify(next.running.map((r) => [r.name, r.sizeVram]));
    if (changed) this.onChange(next, !prev.reachable && next.reachable);
    return next;
  }
}

/** Prüft, ob ein Modell installiert ist ("name" ohne Tag = ":latest"). */
export function hasModel(status: OllamaStatus, model: string): boolean {
  const full = model.includes(':') ? model : `${model}:latest`;
  return status.models.some((m) => m.name === model || m.name === full);
}
