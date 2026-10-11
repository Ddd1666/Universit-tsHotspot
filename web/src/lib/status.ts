import type { Source } from '../types';

export type BadgeKey = `status.${Source['status']}` | 'status.embedPending' | 'status.partial';

/** Badge einer Quelle: gekürzt indexierte Dateien sind „teilweise indexiert“ (Warnfarbe), nicht grün. */
export function sourceBadge(s: Pick<Source, 'status' | 'statusDetail' | 'chunkCount' | 'embeddedCount'>): { key: BadgeKey; cls: string } {
  if (s.status === 'ready') {
    if (s.chunkCount > 0 && s.embeddedCount < s.chunkCount) return { key: 'status.embedPending', cls: 'warn' };
    if ((s.statusDetail ?? '').split(',').some((w) => w === 'truncated_text' || w === 'truncated')) return { key: 'status.partial', cls: 'warn' };
    return { key: 'status.ready', cls: 'ok' };
  }
  const cls = s.status === 'error' ? 'err' : s.status === 'unsupported' || s.status === 'cancelled' ? 'muted' : s.status === 'archive' ? 'ok' : 'accent';
  return { key: `status.${s.status}`, cls };
}

/** Einträge der Embedding-Modell-Auswahl – jedes Modell genau einmal (auch bge-m3, wenn es gewählt, aber nicht installiert ist). */
export function embeddingChoices(installedEmbedModels: string[], current: string): { value: string; installed: boolean }[] {
  const out: { value: string; installed: boolean }[] = [];
  const seen = new Set<string>();
  const add = (value: string, installed: boolean) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, installed });
  };
  const names = installedEmbedModels.map((n) => n.replace(/:latest$/, ''));
  if (!names.includes(current.replace(/:latest$/, ''))) add(current, false);
  for (const n of names) add(n, true);
  add('bge-m3', names.includes('bge-m3'));
  return out;
}
