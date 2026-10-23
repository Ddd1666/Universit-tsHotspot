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
  /** Grund, warum die Datei nur gespeichert wird (z. B. Endung passt nicht zum Inhalt) */
  reason?: string;
}

/**
 * Medien-Signaturen (Magic Bytes). Inhalt hat Vorrang vor der Endung; Medien-Endung ohne passende Signatur
 * wird nicht an ffmpeg/Vision gegeben (Sniffing: "Endung ≠ Inhalt").
 */
export function sniffMedia(h: Buffer, ext = ''): { kind: 'image' | 'audio' | 'video'; mime: string } | null {
  const at = (o: number, s: string) => h.length >= o + s.length && h.subarray(o, o + s.length).toString('latin1') === s;
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return { kind: 'image', mime: 'image/gif' };
  if (at(0, 'RIFF') && at(8, 'WEBP')) return { kind: 'image', mime: 'image/webp' };
  if (at(0, 'RIFF') && at(8, 'WAVE')) return { kind: 'audio', mime: 'audio/wav' };
  if (at(0, 'RIFF') && at(8, 'AVI ')) return { kind: 'video', mime: 'video/x-msvideo' };
  if (at(0, 'BM') && h.length >= 18 && [12, 40, 52, 56, 108, 124].includes(h.readUInt32LE(14))) return { kind: 'image', mime: 'image/bmp' };
  if (at(0, 'II*\0') || at(0, 'MM\0*')) return { kind: 'image', mime: 'image/tiff' };
  if (at(4, 'ftyp')) {
    const brand = h.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(brand)) return { kind: 'image', mime: 'image/heic' };
    if (/^M4[ABP] $/.test(brand)) return { kind: 'audio', mime: 'audio/mp4' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    // MP4-Container: Endung entscheidet zwischen Audio (.m4a) und Video
    return EXT_KIND[ext]?.[0] === 'audio' ? { kind: 'audio', mime: 'audio/mp4' } : { kind: 'video', mime: 'video/mp4' };
  }
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) {
    return h.subarray(0, 64).includes('webm') ? { kind: 'video', mime: 'video/webm' } : { kind: 'video', mime: 'video/x-matroska' };
  }
  if (at(0, 'OggS')) return { kind: 'audio', mime: 'audio/ogg' };
  if (at(0, 'fLaC')) return { kind: 'audio', mime: 'audio/flac' };
  if (at(0, 'ID3')) return { kind: 'audio', mime: 'audio/mpeg' };
  // MPEG-Frame-Sync ohne ID3 ist ein schwaches Signal (kollidiert z. B. mit UTF-16-BOM) -> nur zusammen mit Audio-Endung
  if (h[0] === 0xff && h[1] !== undefined && (h[1] & 0xe0) === 0xe0 && EXT_KIND[ext]?.[0] === 'audio') {
    if ((h[1] & 0xf6) === 0xf0) return { kind: 'audio', mime: 'audio/aac' };
    if ((h[1] & 0x06) !== 0) return { kind: 'audio', mime: 'audio/mpeg' };
  }
  return null;
}

/** Diese Bildformate gibt Uni-Hotspot an das Vision-Modell (TIFF/HEIC/SVG bräuchten Konverter -> nur gespeichert). */
export const VISION_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];

/** Formaterkennung: Dateiendung + Magic Bytes (Endung kann lügen; Inhalt hat Vorrang bei PDF/ZIP/Medien). */
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
  const media = sniffMedia(head, ext);
  if (media) return { ...media, ext };

  const known = EXT_KIND[ext];
  // SVG ist Text (XML) – gespeichert, aber nicht an das Vision-Modell
  if (ext === 'svg' && looksLikeText(head)) return { kind: 'image', mime: 'image/svg+xml', ext };
  // Medien-Endung, aber Inhalt passt zu keinem Medienformat (z. B. umbenannte HTML-/EXE-Datei)
  if (known && ['image', 'audio', 'video'].includes(known[0])) return { kind: 'other', mime: 'application/octet-stream', ext, reason: 'media_mismatch' };
  if (isZip) {
    if (known && ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods'].includes(known[0])) return { kind: known[0], mime: known[1], ext };
    return { kind: 'zip', mime: 'application/zip', ext };
  }
  if (isOle) {
    // DOCX/XLSX/PPTX sind normalerweise ZIP-Container; als OLE-Container gespeichert = passwortverschlüsselt
    if (known && ['docx', 'pptx', 'xlsx'].includes(known[0])) return { kind: 'encrypted-office', mime: known[1], ext };
    return { kind: 'legacy-office', mime: known?.[1] ?? 'application/x-ole-storage', ext };
  }
  if (known) {
    // Office-Endung ohne ZIP-Signatur -> beschädigt/fremd: als "other" speichern
    if (['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'zip'].includes(known[0])) return { kind: 'other', mime: 'application/octet-stream', ext };
    if (known[0] === 'legacy-office') return { kind: known[0], mime: known[1], ext };
    if (looksLikeText(head)) return { kind: known[0], mime: known[1], ext };
    return { kind: 'other', mime: 'application/octet-stream', ext };
  }
  if (CODE_EXT.has(ext) && looksLikeText(head)) return { kind: 'code', mime: 'text/plain', ext };
  if (looksLikeText(head)) return { kind: 'text', mime: 'text/plain', ext };
  return { kind: 'other', mime: 'application/octet-stream', ext };
}

/**
 * Gründe, warum eine Datei nur gespeichert, aber nicht indexiert wird. Bilder/Audio/Video laufen über die
 * Medien-Pipeline (Entscheidung beim Verarbeiten: Werkzeuge vorhanden? Typ eingeschaltet?).
 */
export function unsupportedReason(kind: SourceKind, mime = ''): string | null {
  switch (kind) {
    case 'image':
      return VISION_IMAGE_MIMES.includes(mime) ? null : 'image_format_unsupported';
    case 'legacy-office':
      return 'legacy_office';
    case 'encrypted-office':
      return 'encrypted_office';
    case 'other':
      return 'unknown_format';
    default:
      return null;
  }
}
