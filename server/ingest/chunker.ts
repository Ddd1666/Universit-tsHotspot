import type { BlockLocation, ChunkDraft, TextBlock } from './types.ts';

/** Grobe Token-Schätzung für gemischte DE/EN-Texte – konservativ, weil Zahlen, Tabellen und LaTeX mehr Token pro Zeichen brauchen. */
export const CHARS_PER_TOKEN = 3.0;
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  minTokens: number;
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 600, maxTokens: 800, minTokens: 120, overlapTokens: 60 };

interface Piece {
  text: string;
  loc?: BlockLocation;
  heading?: string;
  role?: TextBlock['role'];
  overlap?: boolean;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…:;])\s+(?=["„“([]?[A-ZÄÖÜ0-9])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Zu lange Absätze an Satzgrenzen (notfalls hart) auf ≤ targetChars aufteilen. */
function splitLong(text: string, targetChars: number, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let cur = '';
  for (const sentence of splitSentences(text).flatMap((s) => hardSplit(s, maxChars))) {
    if (cur && cur.length + sentence.length + 1 > targetChars) {
      parts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) parts.push(cur);
  return parts;
}

function tailForOverlap(text: string, overlapChars: number): string {
  if (overlapChars <= 0) return '';
  const sentences = splitSentences(text);
  let tail = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = tail ? `${sentences[i]} ${tail}` : sentences[i]!;
    if (next.length > overlapChars) break;
    tail = next;
  }
  if (!tail && text.length > overlapChars) {
    const cut = text.indexOf(' ', text.length - overlapChars);
    tail = text.slice(cut === -1 ? text.length - overlapChars : cut + 1);
  }
  return tail.trim();
}

/**
 * Harte Grenzen: Art/Blatt immer; Seiten und Folien ebenfalls – ein Chunk gehört genau zu einer Seite bzw. Folie,
 * damit Zitate präzise bleiben ("S. 3" statt "S. 1–5").
 */
const hardKey = (p: Piece) => {
  const kind = p.loc?.kind ?? '';
  const unit = kind === 'page' || kind === 'slide' ? `|${p.loc?.index ?? ''}` : '';
  return `${kind}|${p.loc?.label ?? ''}${unit}`;
};

/**
 * Strukturbewusstes Chunking: Absätze/Folien/Seiten/Tabellenblätter bleiben Einheiten,
 * Ziel ~600 Token (max. 800), Überlappung ~60 Token innerhalb fortlaufender Texte.
 * Seiten-, Folien- und Blattgrenzen sind harte Grenzen (kein Chunk über mehrere Seiten, keine Überlappung darüber).
 */
export function chunkBlocks(blocks: TextBlock[], options: Partial<ChunkOptions> = {}): ChunkDraft[] {
  const o = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const targetChars = Math.floor(o.targetTokens * CHARS_PER_TOKEN);
  const maxChars = Math.floor(o.maxTokens * CHARS_PER_TOKEN);
  const minChars = Math.floor(o.minTokens * CHARS_PER_TOKEN);
  const overlapChars = Math.floor(o.overlapTokens * CHARS_PER_TOKEN);

  const pieces: Piece[] = [];
  for (const b of blocks) {
    const paragraphs = b.role === 'table' ? b.text.split(/\n(?=\S)/).reduce<string[]>((acc, line) => {
      // Tabellen zeilenweise packen (Kopfzeile steckt bereits im Blocktext)
      const last = acc[acc.length - 1];
      if (last !== undefined && last.length + line.length + 1 <= targetChars) acc[acc.length - 1] = `${last}\n${line}`;
      else acc.push(...hardSplit(line, maxChars));
      return acc;
    }, []) : b.text.split(/\n\s*\n/);
    for (const para of paragraphs) {
      const clean = para.replace(/[ \t]+/g, ' ').trim();
      if (!clean) continue;
      for (const part of splitLong(clean, targetChars, maxChars)) {
        pieces.push({ text: part, loc: b.loc, heading: b.heading, role: b.role });
      }
    }
  }

  const chunks: ChunkDraft[] = [];
  let cur: Piece[] = [];
  let curChars = 0;
  const realPieces = () => cur.filter((p) => !p.overlap);

  const flush = (withOverlap: boolean) => {
    const real = realPieces();
    if (!real.length) {
      cur = [];
      curChars = 0;
      return;
    }
    const text = cur.map((p) => p.text).join('\n\n');
    const first = real[0]!;
    let start: number | null = null;
    let end: number | null = null;
    for (const p of real) {
      const s = p.loc?.index;
      const e = p.loc?.end ?? p.loc?.index;
      if (typeof s === 'number') start = start === null ? s : Math.min(start, s);
      if (typeof e === 'number') end = end === null ? e : Math.max(end, e);
    }
    chunks.push({
      text,
      heading: first.heading ?? real.find((p) => p.heading)?.heading ?? null,
      locKind: first.loc?.kind ?? null,
      locStart: start,
      locEnd: end,
      locLabel: first.loc?.label ?? null,
      tokenEst: estimateTokens(text),
    });
    const last = cur[cur.length - 1]!;
    cur = [];
    curChars = 0;
    if (withOverlap && last.loc?.kind !== 'slide' && last.role !== 'table') {
      const tail = tailForOverlap(last.text, overlapChars);
      if (tail && tail.length < last.text.length) {
        cur.push({ text: tail, loc: last.loc, heading: last.heading, overlap: true });
        curChars = tail.length;
      }
    }
  };

  for (const piece of pieces) {
    const real = realPieces();
    if (real.length) {
      const lastReal = real[real.length - 1]!;
      if (hardKey(lastReal) !== hardKey(piece)) flush(false);
      else if (piece.role === 'heading' && curChars >= minChars) flush(false);
      else if (curChars + piece.text.length + 2 > targetChars && curChars >= minChars) flush(true);
      else if (curChars + piece.text.length + 2 > maxChars) flush(true);
    }
    if (!realPieces().length && curChars + piece.text.length + 2 > maxChars) {
      cur = []; // Überlappung verwerfen, wenn sonst das Maximum überschritten würde
      curChars = 0;
    }
    cur.push(piece);
    curChars += piece.text.length + (cur.length > 1 ? 2 : 0);
  }
  flush(false);
  return chunks;
}

/** Lesbares Positionslabel für Prompts (neutral, Englisch – die UI formatiert lokalisiert). */
export function locationLabel(c: { locKind: string | null; locStart: number | null; locEnd: number | null; locLabel: string | null }): string {
  const range = c.locStart !== null ? (c.locEnd !== null && c.locEnd !== c.locStart ? `${c.locStart}-${c.locEnd}` : `${c.locStart}`) : '';
  switch (c.locKind) {
    case 'page':
      return range ? `page ${range}` : '';
    case 'slide':
      return range ? `slide ${range}` : '';
    case 'sheet':
      return `sheet "${c.locLabel ?? ''}"${range ? `, rows ${range}` : ''}`;
    case 'rows':
      return range ? `rows ${range}` : '';
    case 'lines':
      return range ? `lines ${range}` : '';
    case 'section':
      return c.locLabel ?? '';
    default:
      return '';
  }
}
