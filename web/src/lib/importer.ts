import { post, uploadFile, type UploadHandle } from '../api';
import type { Source } from '../types';
import { randomId } from './format';

export type ItemStatus = 'waiting' | 'uploading' | 'stored' | 'duplicate' | 'error' | 'cancelled';

export interface ImportItem {
  key: string;
  name: string;
  relPath: string | null;
  size: number;
  status: ItemStatus;
  progress: number;
  sourceId?: number;
  serverStatus?: Source['status'];
  serverDetail?: string | null;
  error?: string;
}

export interface ImportSnapshot {
  items: ImportItem[];
  skippedHidden: number;
  active: boolean;
  batchId: string | null;
}

export interface PickedFile {
  file: File;
  relPath: string | null;
}

const HIDDEN = /(^|\/)\.[^/]*$|(^|\/)(Thumbs\.db|desktop\.ini)$|(^|\/)~\$/i;
const FINAL_SERVER = new Set(['ready', 'error', 'unsupported', 'archive', 'cancelled']);

export function isItemFinished(i: ImportItem): boolean {
  if (i.status === 'duplicate' || i.status === 'error' || i.status === 'cancelled') return true;
  return i.status === 'stored' && !!i.serverStatus && FINAL_SERVER.has(i.serverStatus);
}

/** Upload-Warteschlange (max. 2 parallel), unabhängig von React-Renderzyklen. */
export class ImportManager {
  private snap: ImportSnapshot = { items: [], skippedHidden: 0, active: false, batchId: null };
  private listeners = new Set<() => void>();
  private pending: { key: string; file: File; relPath: string | null; subjectId: number | null }[] = [];
  private uploads = new Map<string, UploadHandle>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snap;

  private set(patch: Partial<ImportSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  private updateItem(key: string, patch: Partial<ImportItem>): void {
    this.set({ items: this.snap.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) });
  }

  add(files: PickedFile[], subjectId: number | null): void {
    const visible = files.filter((f) => !HIDDEN.test(f.relPath ?? f.file.name));
    const batchId = this.snap.active && this.snap.batchId ? this.snap.batchId : randomId();
    const newItems: ImportItem[] = visible.map((f) => ({
      key: randomId(),
      name: f.file.name,
      relPath: f.relPath,
      size: f.file.size,
      status: 'waiting',
      progress: 0,
    }));
    newItems.forEach((item, i) => this.pending.push({ key: item.key, file: visible[i]!.file, relPath: visible[i]!.relPath, subjectId }));
    this.set({
      items: [...this.snap.items, ...newItems],
      skippedHidden: this.snap.skippedHidden + (files.length - visible.length),
      active: true,
      batchId,
    });
    this.pump();
  }

  private pump(): void {
    while (this.uploads.size < 2 && this.pending.length) {
      const job = this.pending.shift()!;
      this.updateItem(job.key, { status: 'uploading' });
      const handle = uploadFile(job.file, { relPath: job.relPath, subjectId: job.subjectId, batchId: this.snap.batchId! }, (p) =>
        this.updateItem(job.key, { progress: p }),
      );
      this.uploads.set(job.key, handle);
      handle.promise
        .then((r) => {
          this.updateItem(job.key, {
            status: r.status === 'duplicate' ? 'duplicate' : 'stored',
            progress: 1,
            sourceId: r.source.id,
            serverStatus: r.status === 'duplicate' ? undefined : r.source.status,
            serverDetail: r.source.statusDetail,
          });
        })
        .catch((err: Error & { code?: string }) => {
          this.updateItem(job.key, { status: err.code === 'aborted' ? 'cancelled' : 'error', error: err.message });
        })
        .finally(() => {
          this.uploads.delete(job.key);
          if (!this.pending.length && !this.uploads.size) this.set({ active: false });
          this.pump();
        });
    }
  }

  cancel(): void {
    for (const p of this.pending) this.updateItem(p.key, { status: 'cancelled' });
    this.pending = [];
    for (const h of this.uploads.values()) h.abort();
    if (this.snap.batchId) void post('/api/import/cancel', { batchId: this.snap.batchId }).catch(() => {});
    this.set({ active: false });
  }

  clearFinished(): void {
    this.set({ items: this.snap.items.filter((i) => !isItemFinished(i)), skippedHidden: 0 });
  }

  clearAll(): void {
    if (this.snap.active) return;
    this.set({ items: [], skippedHidden: 0, batchId: null });
  }

  /** Server-Status (via SSE) in die Liste übernehmen. */
  onSource(source: Source): void {
    if (!this.snap.items.some((i) => i.sourceId === source.id)) return;
    this.set({
      items: this.snap.items.map((i) => (i.sourceId === source.id ? { ...i, serverStatus: source.status, serverDetail: source.statusDetail } : i)),
    });
  }
}

/* ------------------------------------------------------------ Drag & Drop inkl. Ordner */

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(cb: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(cb: (entries: FsEntry[]) => void, err: (e: unknown) => void): void };
}

async function readEntry(entry: FsEntry, out: PickedFile[], depth = 0): Promise<void> {
  if (depth > 20 || out.length > 20000) return;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((res, rej) => entry.file!(res, rej));
    const rel = entry.fullPath.replace(/^\//, '');
    out.push({ file, relPath: rel.includes('/') ? rel : null });
  } else if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await readEntry(e, out, depth + 1);
    }
  }
}

export async function collectDropped(dt: DataTransfer): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries: FsEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    for (const e of entries) await readEntry(e, out);
    return out;
  }
  return Array.from(dt.files).map((file) => ({ file, relPath: null }));
}

export function fromInput(list: FileList | null): PickedFile[] {
  return Array.from(list ?? []).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { file, relPath: rel ? rel : null };
  });
}
