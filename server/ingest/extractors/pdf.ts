import fsp from 'node:fs/promises';
import { getDocumentProxy } from 'unpdf';
import { codedError, type Extractor, type TextBlock } from '../types.ts';

interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
}

/** Baut aus pdf.js-Textitems Absätze (Zeilenabstand-Heuristik) inkl. Silbentrennungs-Reparatur. */
export function itemsToParagraphs(items: PdfTextItem[]): string[] {
  const lines: { text: string; y: number | null }[] = [];
  let cur = '';
  let curY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    if (curY === null && it.transform && it.str.trim()) curY = it.transform[5] ?? null;
    cur += it.str;
    if (it.hasEOL) {
      lines.push({ text: cur, y: curY });
      cur = '';
      curY = null;
    }
  }
  if (cur.trim()) lines.push({ text: cur, y: curY });

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!.y;
    const b = lines[i]!.y;
    if (a !== null && b !== null && a > b) gaps.push(a - b);
  }
  gaps.sort((x, y) => x - y);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 0;

  const paragraphs: string[] = [];
  // Absatz als Liste von Zeilen sammeln (Prüfungen nur auf der letzten, kurzen Zeile -> linear)
  let parts: string[] = [];
  const flush = () => {
    if (parts.length) paragraphs.push(parts.join(' '));
    parts = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.text.replace(/\s+/g, ' ').trim();
    const prev = lines[i - 1];
    const gap = prev && prev.y !== null && lines[i]!.y !== null ? prev.y! - lines[i]!.y! : 0;
    const breakHere = !line || (median > 0 && gap > median * 1.6) || gap < 0;
    if (breakHere) flush();
    if (!line) continue;
    const last = parts[parts.length - 1];
    if (last !== undefined && last.endsWith('-') && /[A-Za-zÄÖÜäöüß]/.test(last.charAt(last.length - 2)) && /^[a-zäöüß]/.test(line)) {
      parts[parts.length - 1] = last.slice(0, -1) + line; // Silbentrennung zusammenfügen
    } else parts.push(line);
  }
  flush();
  return paragraphs;
}

export const pdfExtractor: Extractor = {
  id: 'pdf',
  canHandle: ({ kind }) => kind === 'pdf',
  async extract(input) {
    const data = new Uint8Array(await fsp.readFile(input.path));
    let pdf;
    try {
      pdf = await getDocumentProxy(data, { disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'PasswordException') throw codedError('PDF ist passwortgeschützt', 'pdf_encrypted', err);
      throw codedError(`PDF nicht lesbar: ${(err as Error).message}`, 'pdf_invalid', err);
    }
    const blocks: TextBlock[] = [];
    const warnings: string[] = [];
    let emptyPages = 0;
    const numPages = pdf.numPages;
    try {
      for (let p = 1; p <= numPages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        const paragraphs = itemsToParagraphs(content.items as PdfTextItem[]);
        if (!paragraphs.length) emptyPages++;
        for (const text of paragraphs) blocks.push({ text, loc: { kind: 'page', index: p } });
        page.cleanup();
      }
    } finally {
      await pdf.loadingTask.destroy();
    }
    if (emptyPages > 0 && emptyPages === numPages) warnings.push('no_text');
    else if (emptyPages > numPages / 2) warnings.push('partial_text');
    return { blocks, meta: { pages: numPages }, warnings };
  },
};
