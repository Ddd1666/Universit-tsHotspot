import fsp from 'node:fs/promises';
import { decodeText, normalizeText } from '../text-decode.ts';
import { decodeEntities } from '../xml.ts';
import { rowsToBlocks } from './office.ts';
import type { Extractor, ExtractResult, TextBlock } from '../types.ts';

/* ---------------------------------------------------------------- Text / Markdown / Code */

/** Absätze (Leerzeilen-getrennt) mit Zeilennummern; Markdown-Überschriften als Abschnittskontext. */
export function textToBlocks(text: string, opts: { markdown?: boolean } = {}): TextBlock[] {
  const lines = normalizeText(text).split('\n');
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let buf: string[] = [];
  let start = 1;
  let inFence = false;
  const heading = () => (headingStack.length ? headingStack.filter(Boolean).join(' › ') : undefined);
  const flush = (endLine: number) => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ text: t, heading: heading(), loc: { kind: 'lines', index: start, end: endLine } });
    buf = [];
  };
  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (opts.markdown && /^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = opts.markdown && !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      flush(lineNo - 1);
      const level = h[1]!.length;
      headingStack.length = level - 1;
      headingStack[level - 1] = h[2]!;
      blocks.push({ text: h[2]!, heading: heading(), role: 'heading', loc: { kind: 'lines', index: lineNo, end: lineNo } });
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
  async extract(input): Promise<ExtractResult> {
    const raw = decodeText(await fsp.readFile(input.path));
    if (input.ext === 'ipynb') {
      try {
        return { blocks: notebookToBlocks(raw) };
      } catch {
        /* kein gültiges Notebook -> als Text */
      }
    }
    return { blocks: textToBlocks(raw, { markdown: input.kind === 'markdown' }) };
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
    const text = decodeText(await fsp.readFile(input.path));
    const nl = text.indexOf('\n');
    const delimiter = input.ext === 'tsv' ? '\t' : detectDelimiter(text.slice(0, nl === -1 ? 2000 : nl));
    const { rows, truncated } = parseCsv(text, delimiter, limits.maxCells);
    const numbered = rows
      .map((cells, i) => ({ r: i + 1, cells: cells.map((c) => c.replace(/\s+/g, ' ').trim()) }))
      .filter((r) => r.cells.some((c) => c));
    return { blocks: rowsToBlocks(numbered, '', 'rows'), warnings: truncated ? ['truncated'] : [] };
  },
};

/* ---------------------------------------------------------------- HTML */

const BLOCK_TAGS = /^(p|div|section|article|header|footer|li|ul|ol|tr|table|br|hr|blockquote|pre|dd|dt|figcaption|main|nav|aside)$/i;

/** HTML -> Textblöcke. Kein DOM, Skripte/Styles werden verworfen (wird nie ausgeführt oder gerendert). */
export function htmlToBlocks(html: string): { blocks: TextBlock[]; title?: string } {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, (m, tag: string) =>
      tag.toLowerCase() === 'head' ? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(m)?.[0] ?? ' ') : ' ',
    );
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(cleaned);
  const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, '')).trim() : undefined;
  const body = cleaned.replace(/<title[^>]*>[\s\S]*?<\/title>/i, ' ');
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let buf = '';
  const flushPara = () => {
    const text = decodeEntities(buf).replace(/[ \t\r\n\u00a0]+/g, ' ').trim();
    if (text) blocks.push({ text, heading: headingStack.filter(Boolean).join(' › ') || title, loc: { kind: 'section' } });
    buf = '';
  };
  const re = /<\/?([a-zA-Z][\w-]*)[^>]*>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let headingLevel = 0;
  let headingText = '';
  while ((m = re.exec(body))) {
    if (m[2] !== undefined) {
      if (headingLevel) headingText += m[2];
      else buf += m[2];
      continue;
    }
    const tag = m[1]!.toLowerCase();
    const closing = m[0][1] === '/';
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
      if (!closing && buf.trim()) buf += ' | ';
    } else if (BLOCK_TAGS.test(tag)) flushPara();
  }
  flushPara();
  return { blocks, title };
}

export const htmlExtractor: Extractor = {
  id: 'html',
  canHandle: ({ kind }) => kind === 'html',
  async extract(input) {
    const { blocks, title } = htmlToBlocks(decodeText(await fsp.readFile(input.path)));
    return { blocks, meta: { title } };
  },
};
