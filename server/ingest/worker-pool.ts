import { Worker } from 'node:worker_threads';
import { runExtraction, type ExtractOutput } from './extract-run.ts';
import type { ExtractInput, ExtractLimits } from './types.ts';

export class CancelledError extends Error {
  constructor() {
    super('abgebrochen');
  }
}

export interface ExtractionHandle {
  promise: Promise<ExtractOutput>;
  cancel(): void;
}

interface Slot {
  worker: Worker;
  busy: boolean;
}

/**
 * Führt Extraktion in Worker-Threads aus, damit große PDFs etc. den Event-Loop (Chat-Streaming, UI) nicht blockieren.
 * - Worker werden wiederverwendet (Start ~100 ms).
 * - Timeout/Abbruch: Worker wird hart beendet (terminate) und beim nächsten Job neu erzeugt.
 * - Speicherlimit je Worker schützt den Hauptprozess vor bösartigen Dateien.
 */
export class ExtractionPool {
  private slots: Slot[] = [];
  private nextId = 1;
  private readonly inWorker: boolean;
  private readonly timeoutMs: number;
  private readonly maxMemoryMb: number;

  constructor(opts: { inWorker: boolean; timeoutMs?: number; maxMemoryMb?: number }) {
    this.inWorker = opts.inWorker;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    this.maxMemoryMb = opts.maxMemoryMb ?? 2048;
  }

  run(input: ExtractInput, limits: ExtractLimits): ExtractionHandle {
    if (!this.inWorker) {
      let cancelled = false;
      const promise = runExtraction(input, limits).then((r) => {
        if (cancelled) throw new CancelledError();
        return r;
      });
      return { promise, cancel: () => (cancelled = true) };
    }

    let slot = this.slots.find((s) => !s.busy);
    if (!slot) {
      slot = {
        worker: new Worker(new URL('./extract-worker.ts', import.meta.url), {
          resourceLimits: { maxOldGenerationSizeMb: this.maxMemoryMb },
        }),
        busy: false,
      };
      slot.worker.unref();
      this.slots.push(slot);
    }
    const s = slot;
    s.busy = true;
    const id = this.nextId++;
    let settle: { resolve: (r: ExtractOutput) => void; reject: (e: Error) => void } | null = null;
    const promise = new Promise<ExtractOutput>((resolve, reject) => {
      settle = { resolve, reject };
    });

    const cleanup = () => {
      clearTimeout(timer);
      s.worker.off('message', onMessage);
      s.worker.off('error', onError);
      s.worker.off('exit', onExit);
      s.busy = false;
    };
    const kill = (err: Error) => {
      cleanup();
      this.slots = this.slots.filter((x) => x !== s);
      void s.worker.terminate();
      settle?.reject(err);
    };
    const onMessage = (msg: { id: number; ok: boolean; result?: ExtractOutput; error?: string }) => {
      if (msg.id !== id) return;
      cleanup();
      if (msg.ok && msg.result) settle?.resolve(msg.result);
      else settle?.reject(new Error(msg.error ?? 'Extraktion fehlgeschlagen'));
    };
    const onError = (err: Error) => {
      const oom = /memory|heap/i.test(err.message);
      kill(new Error(oom ? 'Datei zu groß/komplex für die Verarbeitung (Speicherlimit)' : err.message));
    };
    const onExit = (code: number) => kill(new Error(`Extraktions-Worker beendet (Code ${code})`));
    const timer = setTimeout(() => kill(new Error('Zeitüberschreitung bei der Extraktion')), this.timeoutMs);

    s.worker.on('message', onMessage);
    s.worker.on('error', onError);
    s.worker.on('exit', onExit);
    s.worker.postMessage({ id, input, limits });
    return { promise, cancel: () => kill(new CancelledError()) };
  }

  async close(): Promise<void> {
    const slots = this.slots;
    this.slots = [];
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}
