/**
 * Einfache Prioritätslogik für Hintergrundarbeit (bewusst kein Framework):
 *   interaktiver Chat > Embedding > Medien (Vision/OCR) > Lernmodus-Generierung
 * - GPU-Arbeit im Hintergrund läuft seriell: immer nur EIN Halter (`acquire`).
 * - Solange ein Chat streamt, bekommt kein Hintergrundjob einen neuen Slot; laufende Einzelaufrufe
 *   (ein Embedding-Batch, ein Vision-Aufruf) laufen zu Ende – sie sind kurz.
 * - Lern-Generierung (lange Modellaufrufe) ist zusätzlich unterbrechbar: `chatSignal()` löst beim nächsten Chat-Start
 *   aus; der Aufrufer wiederholt den Schritt nach der Chat-Antwort (fertige Schritte liegen im Cache).
 * - CPU-Arbeit (whisper.cpp) wartet nur auf "kein Chat" (`whenNoChat`) und läuft mit niedriger Prozesspriorität.
 */
export type JobClass = 'embed' | 'media' | 'learn';
const PRIO: Record<JobClass, number> = { embed: 1, media: 2, learn: 3 };

interface Waiter {
  cls: JobClass;
  seq: number;
  resolve: (release: () => void) => void;
}

function abortError(): Error {
  return Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
}

export class Scheduler {
  private chats = 0;
  private holder: JobClass | null = null;
  private seq = 0;
  private waiters: Waiter[] = [];
  private idle: (() => void)[] = [];
  private chatCtrl = new AbortController();
  private holderCtrl: AbortController | null = null;

  /** Chat beginnt zu streamen; Rückgabe beendet ihn (mehrfacher Aufruf ist harmlos). */
  chatStarted(): () => void {
    this.chats++;
    this.chatCtrl.abort();
    this.chatCtrl = new AbortController();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.chats--;
      this.pump();
    };
  }

  /** Löst aus, sobald der nächste Chat startet (unterbrechbare Hintergrundaufrufe). */
  chatSignal(): AbortSignal {
    return this.chatCtrl.signal;
  }

  /** Signal des aktuellen Slot-Halters: löst aus, sobald eine höhere Klasse wartet (unterbrechbare Lernaufrufe geben dann ab). */
  holderSignal(): AbortSignal {
    return this.holderCtrl?.signal ?? new AbortController().signal;
  }

  get chatActive(): boolean {
    return this.chats > 0;
  }

  /** GPU-Slot für einen Hintergrundjob; Rückgabe = Freigabe. */
  acquire(cls: JobClass, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const w: Waiter = { cls, seq: this.seq++, resolve };
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i !== -1) {
          this.waiters.splice(i, 1);
          reject(abortError());
        }
      };
      w.resolve = (release) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(w);
      if (this.holder && PRIO[cls] < PRIO[this.holder]) this.holderCtrl?.abort();
      this.pump();
    });
  }

  /** Wartet, bis kein Chat mehr streamt (für CPU-Jobs ohne GPU-Slot). */
  whenNoChat(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (!this.chats) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.idle = this.idle.filter((f) => f !== done);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.idle.push(done);
    });
  }

  snapshot(): { chatActive: boolean; holder: JobClass | null; waiting: Record<JobClass, number> } {
    const waiting = { embed: 0, media: 0, learn: 0 };
    for (const w of this.waiters) waiting[w.cls]++;
    return { chatActive: this.chats > 0, holder: this.holder, waiting };
  }

  private pump(): void {
    if (this.chats > 0) return;
    const idle = this.idle;
    this.idle = [];
    for (const f of idle) f();
    if (this.holder || !this.waiters.length) return;
    const next = this.waiters.reduce((a, b) => (PRIO[b.cls] < PRIO[a.cls] || (PRIO[b.cls] === PRIO[a.cls] && b.seq < a.seq) ? b : a));
    this.waiters.splice(this.waiters.indexOf(next), 1);
    this.holder = next.cls;
    const ctrl = new AbortController();
    this.holderCtrl = ctrl;
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      if (this.holderCtrl === ctrl) this.holderCtrl = null;
      this.holder = null;
      this.pump();
    });
  }
}
