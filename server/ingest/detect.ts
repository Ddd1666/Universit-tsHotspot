import type { SourceKind } from './types.ts';

const EXT_KIND: Record<string, [SourceKind, string]> = {
  pdf: ['pdf', 'application/pdf'],
  docx: ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  pptx: ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  xlsx: ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  xlsm: ['xlsx', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  odt: ['odt', 'application/vnd.oasis.opendocument.text'],
  odp: ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ods: ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  doc: ['legacy-office', 'application/msword'],
  ppt: ['legacy-office', 'application/vnd.ms-powerpoint'],
  xls: ['legacy-office', 'application/vnd.ms-excel'],
  csv: ['csv', 'text/csv'],
  tsv: ['csv', 'text/tab-separated-values'],
  html: ['html', 'text/html'],
  htm: ['html', 'text/html'],
  xhtml: ['html', 'application/xhtml+xml'],
  md: ['markdown', 'text/markdown'],
  markdown: ['markdown', 'text/markdown'],
  txt: ['text', 'text/plain'],
  text: ['text', 'text/plain'],
  log: ['text', 'text/plain'],
  rst: ['text', 'text/plain'],
  tex: ['text', 'application/x-tex'],
  bib: ['text', 'application/x-bibtex'],
  json: ['json', 'application/json'],
  ipynb: ['json', 'application/x-ipynb+json'],
  zip: ['zip', 'application/zip'],
  png: ['image', 'image/png'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'],
  bmp: ['image', 'image/bmp'],
  tif: ['image', 'image/tiff'],
  tiff: ['image', 'image/tiff'],
  heic: ['image', 'image/heic'],
  svg: ['image', 'image/svg+xml'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  m4a: ['audio', 'audio/mp4'],
  ogg: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  aac: ['audio', 'audio/aac'],
  opus: ['audio', 'audio/opus'],
  mp4: ['video', 'video/mp4'],
  mkv: ['video', 'video/x-matroska'],
  mov: ['video', 'video/quicktime'],
  webm: ['video', 'video/webm'],
  avi: ['video', 'video/x-msvideo'],
};

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'kt', 'kts', 'scala', 'r', 'm', 'sql', 'sh', 'bash', 'ps1', 'bat', 'css', 'scss', 'less', 'vue', 'svelte',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'jl', 'hs', 'lua', 'pl', 'dart', 'f90', 'asm', 'vhd', 'v',
  'gradle', 'cmake', 'dockerfile', 'makefile',
]);

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const lower = base.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return lower;
  const i = lower.lastIndexOf('.');
  return i > 0 ? lower.slice(i + 1) : '';
}

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  // UTF-16 BOM
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) return true;
  let suspicious = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / head.length < 0.02;
}

export interface Detected {
  kind: SourceKind;
  mime: string;
  ext: string;
}

/** Formaterkennung: Dateiendung + Magic Bytes (Endung kann lügen; Inhalt hat Vorrang bei PDF/ZIP/Bildern). */
export function detectKind(name: string, head: Buffer): Detected {
  const ext = extOf(name);
  const magic = head.subarray(0, 8);
  const isPdf = magic.subarray(0, 5).toString('latin1') === '%PDF-';
  const isZip = magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 3 || magic[2] === 5) ;
  const isPng = magic[0] === 0x89 && magic.subarray(1, 4).toString('latin1') === 'PNG';
  const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
  const isOle = magic.toString('hex') === 'd0cf11e0a1b11ae1'; // altes Office-Format

  if (isPdf) return { kind: 'pdf', mime: 'application/pdf', ext };
  if (isPng) return { kind: 'image', mime: 'image/png', ext };
  if (isJpeg) return { kind: 'image', mime: 'image/jpeg', ext };

  const known = EXT_KIND[ext];
  if (isZip) {
    if (known && ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'].includes(known[0])) return { kind: known[0], mime: known[1], ext };
    return { kind: 'zip', mime: 'application/zip', ext };
  }
  if (isOle) return { kind: 'legacy-office', mime: known?.[1] ?? 'application/x-ole-storage', ext };
  if (known) {
    // Office-Endung ohne ZIP-Signatur -> beschädigt/fremd: als "other" speichern
    if (['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'zip'].includes(known[0])) return { kind: 'other', mime: 'application/octet-stream', ext };
    if (['image', 'audio', 'video', 'legacy-office'].includes(known[0])) return { kind: known[0], mime: known[1], ext };
    if (looksLikeText(head)) return { kind: known[0], mime: known[1], ext };
    return { kind: 'other', mime: 'application/octet-stream', ext };
  }
  if (CODE_EXT.has(ext) && looksLikeText(head)) return { kind: 'code', mime: 'text/plain', ext };
  if (looksLikeText(head)) return { kind: 'text', mime: 'text/plain', ext };
  return { kind: 'other', mime: 'application/octet-stream', ext };
}

/** Gründe, warum eine Datei (in Phase 1) nur gespeichert, aber nicht indexiert wird. */
export function unsupportedReason(kind: SourceKind): string | null {
  switch (kind) {
    case 'image':
    case 'audio':
    case 'video':
      return 'phase2_media';
    case 'legacy-office':
      return 'legacy_office';
    case 'other':
      return 'unknown_format';
    default:
      return null;
  }
}
