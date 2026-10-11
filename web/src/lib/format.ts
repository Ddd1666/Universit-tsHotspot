import type { T } from '../i18n';

/** Animationen reduzieren (Systemeinstellung oder App-Einstellung "Reduziert")? */
export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.motion === 'reduced' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDate(ts: number, lang: string): string {
  return new Date(ts).toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatTime(ts: number, lang: string): string {
  return new Date(ts).toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
}

export interface LocLike {
  locKind: string | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
}

export function locLabel(c: LocLike, t: T): string {
  const range = c.locStart !== null ? (c.locEnd !== null && c.locEnd !== c.locStart ? `${c.locStart}–${c.locEnd}` : `${c.locStart}`) : '';
  switch (c.locKind) {
    case 'page':
      return range ? t('src.page', { n: range }) : '';
    case 'slide':
      return range ? t('src.slide', { n: range }) : '';
    case 'sheet':
      return t('src.sheet', { label: c.locLabel ?? '' }) + (range ? ', ' + t('src.rows', { n: range }) : '');
    case 'rows':
      return range ? t('src.rows', { n: range }) : '';
    case 'lines':
      return range ? t('src.lines', { n: range }) : '';
    case 'section':
      return c.locLabel ?? '';
    default:
      return '';
  }
}

export function dayBucket(ts: number): 'today' | 'yesterday' | 'week' | 'older' {
  const d = new Date(ts);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return 'today';
  if (d.getTime() >= startToday - 86400000) return 'yesterday';
  if (d.getTime() >= startToday - 7 * 86400000) return 'week';
  return 'older';
}

export const SUBJECT_COLORS = ['#39e6ff', '#a77bff', '#ff4fd8', '#3dffa8', '#ffc857', '#ff7a59', '#5b8cff', '#f0f4ff'];

export function randomId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Snippet mit \u0002…\u0003-Markierungen -> Teile für React (<mark> ohne innerHTML). */
export function snippetParts(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  // eslint-disable-next-line no-control-regex
  const re = /\u0002([\s\S]*?)\u0003/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), mark: false });
    out.push({ text: m[1]!, mark: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), mark: false });
  return out;
}

export function kindIcon(kind: string): string {
  switch (kind) {
    case 'pdf':
      return 'pdf';
    case 'docx':
    case 'odt':
      return 'doc';
    case 'pptx':
    case 'odp':
      return 'slides';
    case 'xlsx':
    case 'ods':
    case 'csv':
      return 'sheet';
    case 'zip':
      return 'archive';
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'code':
    case 'json':
      return 'code';
    default:
      return 'file';
  }
}
