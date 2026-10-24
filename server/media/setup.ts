import type { EventBus } from '../events.ts';
import { HttpError } from '../library.ts';
import { currentPlatform, download, install, isInstalled, loadManifest, setupErrorCode, type Manifest } from './installer.ts';

export interface SetupState {
  running: boolean;
  queue: string[];
  current: string | null;
  received: number;
  total: number;
  done: string[];
  error: { id: string; code: string } | null;
}

/** Steuerung des Werkzeug-Downloads aus den Einstellungen (Start nur mit ausdrücklicher Bestätigung). */
export class MediaSetup {
  private st: SetupState = { running: false, queue: [], current: null, received: 0, total: 0, done: [], error: null };
  private ctrl: AbortController | null = null;
  private job: Promise<void> | null = null;
  private lastEmit = 0;
  private readonly deps: { toolsDir: string; manifestFile: string; bus: EventBus; log: (m: string, e?: unknown) => void; onInstalled: () => void; allowLocalHttp?: boolean };

  constructor(deps: MediaSetup['deps']) {
    this.deps = deps;
  }

  manifest(): Manifest | null {
    try {
      return loadManifest(this.deps.manifestFile, { allowLocalHttp: this.deps.allowLocalHttp });
    } catch (err) {
      this.deps.log('Medien-Manifest ungültig', (err as Error).message);
      return null;
    }
  }

  status() {
    const m = this.manifest();
    const platform = currentPlatform();
    return {
      supported: !!m && m.platform === platform,
      platform,
      toolsDir: this.deps.toolsDir,
      items: (m?.items ?? []).map((it) => ({ id: it.id, label: it.label, size: it.size, url: it.url, installed: isInstalled(this.deps.toolsDir, it) })),
      setup: { ...this.st },
    };
  }

  start(ids: string[], confirmed: boolean): void {
    if (!confirmed) throw new HttpError(400, 'media_setup_confirm', 'Download muss ausdrücklich bestätigt werden');
    if (this.st.running) throw new HttpError(409, 'media_setup_running', 'Installation läuft bereits');
    const m = this.manifest();
    if (!m) throw new HttpError(500, 'media_manifest', 'Manifest fehlt oder ist ungültig');
    if (m.platform !== currentPlatform()) throw new HttpError(409, 'media_platform', `Automatische Installation nur für ${m.platform}`, m.platform);
    const items = ids.map((id) => m.items.find((x) => x.id === id));
    if (!ids.length || items.some((x) => !x)) throw new HttpError(400, 'media_unknown_item', 'Unbekannter Eintrag');
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    this.st = { running: true, queue: [...ids], current: null, received: 0, total: 0, done: [], error: null };
    this.emit(true);
    this.job = (async () => {
      for (const it of items) {
        this.st.current = it!.id;
        this.st.received = 0;
        this.st.total = it!.size;
        this.emit(true);
        try {
          const file = await download(it!, this.deps.toolsDir, {
            signal,
            onProgress: (received) => {
              this.st.received = received;
              this.emit();
            },
          });
          await install(it!, this.deps.toolsDir, file);
          this.st.done.push(it!.id);
          this.deps.log(`Medien-Werkzeug installiert: ${it!.id}`);
        } catch (err) {
          const code = setupErrorCode(err);
          this.st.error = { id: it!.id, code };
          this.deps.log(`Medien-Werkzeug fehlgeschlagen: ${it!.id}`, (err as Error).message);
          break;
        }
      }
      this.st.running = false;
      this.st.current = null;
      this.emit(true);
      if (this.st.done.length) this.deps.onInstalled();
    })();
  }

  async cancel(): Promise<void> {
    this.ctrl?.abort();
    await this.job;
  }

  /** Tests */
  idle(): Promise<void> {
    return this.job ?? Promise.resolve();
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 300) return;
    this.lastEmit = now;
    this.deps.bus.emit({ type: 'media-setup', setup: { ...this.st } });
  }
}
