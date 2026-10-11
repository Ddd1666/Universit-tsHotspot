import { decodeText, normalizeText, readTextCapped } from '../text-decode.ts';
import { decodeEntities } from '../xml.ts';
import { rowsToBlocks } from './office.ts';
import type { Extractor, ExtractResult, TextBlock } from '../types.ts';

/* ---------------------------------------------------------------- Text / Markdown / Code */

/**
 * Max. Zeichen je Textblock: lange Abschnitte ohne Leerzeilen werden mit korrektem Zeilenbereich geteilt.
 * Bewusst kleiner als die Chunk-Zielgröße, damit der Chunker Blöcke nie zerteilt (sonst ungenaue Zeilenangaben).
 */
const MAX_BLOCK_CHARS = 1200;

/** Markdown-Überschrift linear erkennen (kein Regex mit verschachtelten Quantoren -> kein ReDoS). */
export function parseMdHeading(line: string): { level: number; text: string } | null {
  let level = 0;
  while (level < line.length && level < 7 && line[level] === '#') level++;
  if (level === 0 || level > 6) return null;
  const next = line[level];
  if (next !== ' ' && next !== '\t') return null;
  let text = line.slice(level).trim();
  // optionale schließende #-Folge ("## Titel ##")
  let j = text.length;
  while (j > 0 && text[j - 1] === '#') j--;
  if (j < text.length && (j === 0 || text[j - 1] === ' ' || text[j - 1] === '\t')) text = text.slice(0, j).trim();
  return text ? { level, text } : null;
}

const isFence = (line: string) => {
  const t = line.trimStart();
  return t.startsWith('```') || t.startsWith('~~~');
};

/** Absätze (Leerzeilen-getrennt) mit Zeilennummern; Markdown-Überschriften als Abschnittskontext. */
export function textToBlocks(text: string, opts: { markdown?: boolean } = {}): TextBlock[] {
  const lines = normalizeText(text).split('\n');
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let buf: string[] = [];
  let bufChars = 0;
  let start = 1;
  let inFence = false;
  const heading = () => (headingStack.length ? headingStack.filter(Boolean).join(' › ') : undefined);
  const flush = (endLine: number) => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ text: t, heading: heading(), loc: { kind: 'lines', index: start, end: endLine } });
    buf = [];
    bufChars = 0;
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (opts.markdown && isFence(line)) inFence = !inFence;
    const h = opts.markdown && !inFence ? parseMdHeading(line) : null;
    if (h) {
      flush(lineNo - 1);
      headingStack.length = h.level - 1;
      headingStack[h.level - 1] = h.text;
      blocks.push({ text: h.text, heading: heading(), role: 'heading', loc: { kind: 'lines', index: lineNo, end: lineNo } });
      start = lineNo + 1;
      return;
    }
    if (!inFence && !line.trim()) {
      flush(lineNo - 1);
      start = lineNo + 1;
      return;
    }
    if (!buf.length) start = lineNo;
    buf.push(line);
    bufChars += line.length + 1;
    if (bufChars >= MAX_BLOCK_CHARS) flush(lineNo);
  });
  flush(lines.length);
  return blocks;
}

function notebookToBlocks(raw: string): TextBlock[] {
  const nb = JSON.parse(raw) as { cells?: { cell_type?: string; source?: string | string[] }[] };
  const blocks: TextBlock[] = [];
  (nb.cells ?? []).forEach((cell, i) => {
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
    for (const b of textToBlocks(src, { markdown: cell.cell_type === 'markdown' })) {
      blocks.push({ ...b, loc: { kind: 'section', index: i + 1, label: `Zelle ${i + 1}` } });
    }
  });
  return blocks;
}

export const textExtractor: Extractor = {
  id: 'text',
  canHandle: ({ kind }) => kind === 'text' || kind === 'markdown' || kind === 'code' || kind === 'json',
  async extract(input, limits): Promise<ExtractResult> {
    const { buf, truncated } = await readTextCapped(input.path, limits.maxTextBytes);
    const raw = decodeText(buf);
    const warnings = truncated ? ['truncated_text'] : [];
    if (input.ext === 'ipynb' && !truncated) {
      try {
        return { blocks: notebookToBlocks(raw) };
      } catch {
        /* kein gültiges Notebook -> als Text */
      }
    }
    return { blocks: textToBlocks(raw, { markdown: input.kind === 'markdown' }), warnings };
  },
};

/* ---------------------------------------------------------------- CSV / TSV */

export function detectDelimiter(firstLine: string): string {
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/** RFC-4180-CSV-Parser (Anführungszeichen, eingebettete Zeilenumbrüche). */
export function parseCsv(text: string, delimiter: string, maxCells = Infinity): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let cells = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      cells += row.length;
      row = [];
      if (cells >= maxCells) return { rows, truncated: true };
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows, truncated: false };
}

export const csvExtractor: Extractor = {
  id: 'csv',
  canHandle: ({ kind }) => kind === 'csv',
  async extract(input, limits) {
    const capped = await readTextCapped(input.path, limits.maxTextBytes);
    const text = decodeText(capped.buf);
    const nl = text.indexOf('\n');
    const delimiter = input.ext === 'tsv' ? '\t' : detectDelimiter(text.slice(0, nl === -1 ? 2000 : nl));
    const { rows, truncated } = parseCsv(text, delimiter, limits.maxCells);
    const numbered = rows
      .map((cells, i) => ({ r: i + 1, cells: cells.map((c) => c.replace(/\s+/g, ' ').trim()) }))
      .filter((r) => r.cells.some((c) => c));
    return { blocks: rowsToBlocks(numbered, '', 'rows'), warnings: truncated ? ['truncated'] : capped.truncated ? ['truncated_text'] : [] };
  },
};

/* ---------------------------------------------------------------- HTML */

const BLOCK_TAGS = /^(p|div|section|article|header|footer|li|ul|ol|tr|table|br|hr|blockquote|pre|dd|dt|figcaption|main|nav|aside)$/i;

/** Kommentare linear entfernen (indexOf statt Regex -> kein quadratisches Verhalten bei offenen "<!--"). */
function stripComments(html: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = html.indexOf('<!--', i);
    if (open === -1) return out + html.slice(i);
    out += html.slice(i, open) + ' ';
    const close = html.indexOf('-->', open + 4);
    if (close === -1) return out;
    i = close + 3;
  }
}

/** Inhalt von script/style/… entfernen; nicht geschlossene Elemente schneiden den Rest ab (linear). */
function stripRawElements(html: string): string {
  const openRe = /<(script|style|noscript|template|svg|head)(?=[\s>/])/gi;
  let out = '';
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(html);
    if (!m) return out + html.slice(i);
    out += html.slice(i, m.index) + ' ';
    const closeRe = new RegExp(`</${m[1]}\\s*>`, 'gi');
    closeRe.lastIndex = m.index + m[0].length;
    const c = closeRe.exec(html);
    if (!c) return out;
    i = c.index + c[0].length;
  }
}

/** HTML -> Textblöcke. Kein DOM, Skripte/Styles werden verworfen (wird nie ausgeführt oder gerendert). Linear in der Eingabe. */
export function htmlToBlocks(html: string): { blocks: TextBlock[]; title?: string } {
  const titleMatch = /<title[^>]{0,200}>([^<]{0,2000})<\/title>/i.exec(html.slice(0, 200_000));
  const title = titleMatch ? decodeEntities(titleMatch[1]!).replace(/\s+/g, ' ').trim() || undefined : undefined;
  const body = stripRawElements(stripComments(html));
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let buf = '';
  let bufHasText = false;
  let headingLevel = 0;
  let headingText = '';
  const flushPara = () => {
    const text = decodeEntities(buf).replace(/[ \t\r\n\u00a0]+/g, ' ').trim();
    if (text) blocks.push({ text, heading: headingStack.filter(Boolean).join(' › ') || title, loc: { kind: 'section' } });
    buf = '';
    bufHasText = false;
  };
  const addText = (t: string) => {
    if (headingLevel) headingText += t;
    else {
      buf += t;
      if (!bufHasText && t.trim()) bufHasText = true;
    }
  };
  const n = body.length;
  let i = 0;
  let nextGt = -1;
  while (i < n) {
    const lt = body.indexOf('<', i);
    if (lt === -1) {
      addText(body.slice(i));
      break;
    }
    if (lt > i) addText(body.slice(i, lt));
    if (nextGt < lt) nextGt = body.indexOf('>', lt);
    if (nextGt === -1) {
      addText(body.slice(lt)); // kein weiteres Tag möglich
      break;
    }
    const m = /^\/?([a-zA-Z][\w-]{0,40})/.exec(body.slice(lt + 1, Math.min(nextGt, lt + 50)));
    if (!m) {
      addText('<');
      i = lt + 1;
      continue;
    }
    i = nextGt + 1;
    const tag = m[1]!.toLowerCase();
    const closing = m[0][0] === '/';
    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      if (!closing) {
        flushPara();
        headingLevel = Number(h[1]);
        headingText = '';
      } else if (headingLevel) {
        const text = decodeEntities(headingText).replace(/\s+/g, ' ').trim();
        if (text) {
          headingStack.length = headingLevel - 1;
          headingStack[headingLevel - 1] = text;
          blocks.push({ text, heading: headingStack.filter(Boolean).join(' › '), role: 'heading', loc: { kind: 'section' } });
        }
        headingLevel = 0;
      }
    } else if (tag === 'td' || tag === 'th') {
      if (!closing && bufHasText) buf += ' | ';
    } else if (BLOCK_TAGS.test(tag)) flushPara();
  }
  flushPara();
  return { blocks, title };
}

export const htmlExtractor: Extractor = {
  id: 'html',
  canHandle: ({ kind }) => kind === 'html',
  async extract(input, limits) {
    const { buf, truncated } = await readTextCapped(input.path, limits.maxTextBytes);
    const { blocks, title } = htmlToBlocks(decodeText(buf));
    return { blocks, meta: { title }, warnings: truncated ? ['truncated_text'] : [] };
  },
};
