import path from 'node:path';
import { readZipParts } from '../zip.ts';
import { tokenize } from '../xml.ts';
import { codedError, type Extractor, type ExtractResult, type TextBlock } from '../types.ts';

/* ---------------------------------------------------------------- Hilfen */

export function parseRels(xml: string | undefined, baseDir: string): Map<string, { type: string; target: string }> {
  const rels = new Map<string, { type: string; target: string }>();
  if (!xml) return rels;
  for (const t of tokenize(xml)) {
    if (t.type !== 'open' || t.name !== 'Relationship') continue;
    const id = t.attrs.Id;
    const target = t.attrs.Target;
    if (!id || !target || t.attrs.TargetMode === 'External') continue;
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target));
    rels.set(id, { type: t.attrs.Type ?? '', target: resolved });
  }
  return rels;
}

function str(buf: Buffer | undefined): string | undefined {
  return buf ? buf.toString('utf8') : undefined;
}

function relsPathFor(part: string): string {
  return path.posix.join(path.posix.dirname(part), '_rels', path.posix.basename(part) + '.rels');
}

/* ---------------------------------------------------------------- DOCX */

function parseDocxStyles(xml: string | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  if (!xml) return levels;
  let current: string | null = null;
  for (const t of tokenize(xml)) {
    if (t.type === 'open' && t.name === 'w:style') current = t.attrs['w:styleId'] ?? null;
    else if (t.type === 'close' && t.name === 'w:style') current = null;
    else if (t.type === 'open' && current) {
      if (t.name === 'w:name') {
        const name = (t.attrs['w:val'] ?? '').toLowerCase();
        const m = /^heading (\d)$/.exec(name);
        if (m) levels.set(current, Number(m[1]));
        else if (name === 'title') levels.set(current, 1);
      } else if (t.name === 'w:outlineLvl' && !levels.has(current)) {
        const lvl = Number(t.attrs['w:val']);
        if (Number.isInteger(lvl) && lvl >= 0 && lvl < 9) levels.set(current, lvl + 1);
      }
    }
  }
  return levels;
}

export function parseDocx(documentXml: string, stylesXml?: string): ExtractResult {
  const styleLevels = parseDocxStyles(stylesXml);
  const hasPageInfo = documentXml.includes('lastRenderedPageBreak') || /w:type="page"/.test(documentXml);
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let page = 1;
  let para: { text: string; level: number } | null = null;
  let inText = false;
  let fallbackDepth = 0;
  let tableDepth = 0;
  let row: string[] | null = null;
  let cell: string | null = null;
  let tableRows: string[] = [];

  const headingPath = () => (headingStack.length ? headingStack.filter(Boolean).join(' › ') : undefined);
  const loc = () => (hasPageInfo ? { kind: 'page' as const, index: page } : { kind: 'section' as const });

  for (const t of tokenize(documentXml)) {
    if (t.type === 'open' && t.name === 'mc:Fallback' && !t.selfClosing) fallbackDepth++;
    else if (t.type === 'close' && t.name === 'mc:Fallback') fallbackDepth--;
    if (fallbackDepth > 0) continue;

    if (t.type === 'open') {
      switch (t.name) {
        case 'w:p':
          if (!t.selfClosing) para = { text: '', level: 0 };
          break;
        case 'w:pStyle':
          if (para) para.level = styleLevels.get(t.attrs['w:val'] ?? '') ?? para.level;
          break;
        case 'w:outlineLvl':
          if (para && !para.level) {
            const lvl = Number(t.attrs['w:val']);
            if (Number.isInteger(lvl) && lvl < 9) para.level = lvl + 1;
          }
          break;
        case 'w:t':
          inText = !t.selfClosing;
          break;
        case 'w:tab':
          if (para) para.text += '\t';
          break;
        case 'w:br':
          if (t.attrs['w:type'] === 'page') page++;
          else if (para) para.text += '\n';
          break;
        case 'w:cr':
          if (para) para.text += '\n';
          break;
        case 'w:lastRenderedPageBreak':
          page++;
          break;
        case 'w:tbl':
          tableDepth++;
          break;
        case 'w:tr':
          if (tableDepth === 1) row = [];
          break;
        case 'w:tc':
          if (tableDepth === 1) cell = '';
          break;
      }
    } else if (t.type === 'close') {
      switch (t.name) {
        case 'w:t':
          inText = false;
          break;
        case 'w:p': {
          if (!para) break;
          const text = para.text.replace(/[ \t]+/g, ' ').trim();
          if (tableDepth > 0) {
            if (cell !== null && text) cell += (cell ? ' ' : '') + text;
          } else if (text) {
            if (para.level > 0) {
              headingStack.length = para.level - 1;
              headingStack[para.level - 1] = text;
              blocks.push({ text, heading: headingPath(), role: 'heading', loc: loc() });
            } else {
              blocks.push({ text, heading: headingPath(), role: 'body', loc: loc() });
            }
          }
          para = null;
          break;
        }
        case 'w:tc':
          if (tableDepth === 1 && row && cell !== null) row.push(cell);
          cell = tableDepth === 1 ? null : cell;
          break;
        case 'w:tr':
          if (tableDepth === 1 && row) {
            if (row.some((c) => c)) tableRows.push(row.join(' | '));
            row = null;
          }
          break;
        case 'w:tbl':
          tableDepth--;
          if (tableDepth === 0 && tableRows.length) {
            blocks.push({ text: tableRows.join('\n'), heading: headingPath(), role: 'table', loc: loc() });
            tableRows = [];
          }
          break;
      }
    } else if (t.type === 'text' && inText && para) {
      para.text += t.text;
    }
  }
  return { blocks, meta: hasPageInfo ? { pages: page } : {} };
}

export const docxExtractor: Extractor = {
  id: 'docx',
  canHandle: ({ kind }) => kind === 'docx',
  async extract(input, limits) {
    const parts = await readZipParts(input.path, (n) => n === 'word/document.xml' || n === 'word/styles.xml', limits.maxPartBytes);
    const doc = str(parts.get('word/document.xml'));
    if (!doc) throw codedError('DOCX ohne word/document.xml (beschädigt?)', 'office_corrupt');
    return parseDocx(doc, str(parts.get('word/styles.xml')));
  },
};

/* ---------------------------------------------------------------- PPTX */

interface SlideText {
  title: string;
  body: string[];
}

export function parseSlideXml(xml: string, opts: { notes?: boolean } = {}): SlideText {
  const res: SlideText = { title: '', body: [] };
  let shape: { ph: string | null; paras: string[] } | null = null;
  let para: string | null = null;
  let inText = false;
  let fallbackDepth = 0;
  let row: string[] | null = null;
  let cell: string | null = null;
  for (const t of tokenize(xml)) {
    if (t.type === 'open' && t.name === 'mc:Fallback' && !t.selfClosing) fallbackDepth++;
    else if (t.type === 'close' && t.name === 'mc:Fallback') fallbackDepth--;
    if (fallbackDepth > 0) continue;
    if (t.type === 'open') {
      if (t.name === 'p:sp' && !t.selfClosing) shape = { ph: null, paras: [] };
      else if (t.name === 'p:ph' && shape) shape.ph = t.attrs.type ?? 'body';
      else if (t.name === 'a:p' && !t.selfClosing) para = '';
      else if (t.name === 'a:t') inText = !t.selfClosing;
      else if (t.name === 'a:br' && para !== null) para += '\n';
      else if (t.name === 'a:tr') row = [];
      else if (t.name === 'a:tc' && !t.selfClosing) cell = '';
    } else if (t.type === 'close') {
      if (t.name === 'a:t') inText = false;
      else if (t.name === 'a:p' && para !== null) {
        const text = para.replace(/[ \t]+/g, ' ').trim();
        if (text) {
          if (cell !== null) cell += (cell ? ' ' : '') + text;
          else if (shape) shape.paras.push(text);
          else res.body.push(text);
        }
        para = null;
      } else if (t.name === 'a:tc') {
        if (row && cell !== null) row.push(cell);
        cell = null;
      } else if (t.name === 'a:tr') {
        if (row && row.some((c) => c)) res.body.push(row.join(' | '));
        row = null;
      } else if (t.name === 'p:sp' && shape) {
        const ph = shape.ph;
        if (opts.notes) {
          // Notizenfolie: nur echte Notiztexte (keine Foliennummer, Kopf-/Fußzeile)
          if (ph === 'body' || ph === null) res.body.push(...shape.paras);
        } else if (ph === 'title' || ph === 'ctrTitle') {
          res.title = [res.title, ...shape.paras].filter(Boolean).join(' – ');
        } else if (ph !== 'sldNum' && ph !== 'dt' && ph !== 'ftr' && ph !== 'hdr') {
          res.body.push(...shape.paras);
        }
        shape = null;
      }
    } else if (t.type === 'text' && inText && para !== null) {
      para += t.text;
    }
  }
  return res;
}

export const pptxExtractor: Extractor = {
  id: 'pptx',
  canHandle: ({ kind }) => kind === 'pptx',
  async extract(input, limits) {
    const parts = await readZipParts(
      input.path,
      (n) =>
        n === 'ppt/presentation.xml' ||
        n === 'ppt/_rels/presentation.xml.rels' ||
        /^ppt\/slides\/(_rels\/)?slide\d+\.xml(\.rels)?$/.test(n) ||
        /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n),
      limits.maxPartBytes,
    );
    const pres = str(parts.get('ppt/presentation.xml'));
    if (!pres) throw codedError('PPTX ohne ppt/presentation.xml (beschädigt?)', 'office_corrupt');
    const rels = parseRels(str(parts.get('ppt/_rels/presentation.xml.rels')), 'ppt');
    const order: string[] = [];
    for (const t of tokenize(pres)) {
      if (t.type === 'open' && t.name === 'p:sldId') {
        const rel = rels.get(t.attrs['r:id'] ?? '');
        if (rel) order.push(rel.target);
      }
    }
    if (!order.length) {
      // Fallback: numerische Reihenfolge der Folien-Dateien
      for (const name of parts.keys()) if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) order.push(name);
      order.sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
    }
    const blocks: TextBlock[] = [];
    order.forEach((slidePath, i) => {
      const slideNo = i + 1;
      const xml = str(parts.get(slidePath));
      if (!xml) return;
      const slide = parseSlideXml(xml);
      const title = slide.title || undefined;
      const body = slide.body.join('\n');
      const text = [title, body].filter(Boolean).join('\n');
      if (text) blocks.push({ text, heading: title, role: 'body', loc: { kind: 'slide', index: slideNo } });
      const slideRels = parseRels(str(parts.get(relsPathFor(slidePath))), path.posix.dirname(slidePath));
      for (const rel of slideRels.values()) {
        if (!rel.type.endsWith('/notesSlide')) continue;
        const notesXml = str(parts.get(rel.target));
        if (!notesXml) continue;
        const notes = parseSlideXml(notesXml, { notes: true }).body.join('\n').trim();
        if (notes) blocks.push({ text: notes, heading: title, role: 'notes', loc: { kind: 'slide', index: slideNo } });
      }
    });
    return { blocks, meta: { pages: order.length } };
  },
};

/* ---------------------------------------------------------------- XLSX */

function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseSharedStrings(xml: string | undefined): string[] {
  const out: string[] = [];
  if (!xml) return out;
  let cur: string | null = null;
  let inT = false;
  let phonetic = 0;
  for (const t of tokenize(xml)) {
    if (t.type === 'open') {
      if (t.name === 'si') cur = '';
      else if (t.name === 'rPh' && !t.selfClosing) phonetic++;
      else if (t.name === 't') inT = !t.selfClosing;
    } else if (t.type === 'close') {
      if (t.name === 'si') {
        out.push(cur ?? '');
        cur = null;
      } else if (t.name === 'rPh') phonetic--;
      else if (t.name === 't') inT = false;
    } else if (inT && cur !== null && phonetic === 0) cur += t.text;
  }
  return out;
}

export interface SheetRows {
  rows: { r: number; cells: string[] }[];
  truncated: boolean;
  cellCount: number;
}

export function parseSheetXml(xml: string, shared: string[], maxCells: number): SheetRows {
  const rows: { r: number; cells: string[] }[] = [];
  let row: { r: number; cells: string[] } | null = null;
  let cell: { col: number; type: string; v: string; inline: string } | null = null;
  let mode: 'v' | 't' | null = null;
  let cellCount = 0;
  let truncated = false;
  for (const t of tokenize(xml)) {
    if (t.type === 'open') {
      if (t.name === 'row') {
        row = { r: Number(t.attrs.r) || rows.length + 1, cells: [] };
        if (t.selfClosing) row = null;
      } else if (t.name === 'c') {
        cell = { col: colIndex(t.attrs.r ?? ''), type: t.attrs.t ?? 'n', v: '', inline: '' };
        if (t.selfClosing) cell = null;
      } else if (t.name === 'v' && cell) mode = 'v';
      else if (t.name === 't' && cell) mode = 't';
    } else if (t.type === 'close') {
      if (t.name === 'v' || t.name === 't') mode = null;
      else if (t.name === 'c' && cell && row) {
        let value: string;
        switch (cell.type) {
          case 's':
            value = shared[Number(cell.v)] ?? '';
            break;
          case 'inlineStr':
            value = cell.inline;
            break;
          case 'b':
            value = cell.v === '1' ? 'TRUE' : 'FALSE';
            break;
          default:
            value = cell.v;
        }
        value = value.replace(/\s+/g, ' ').trim();
        if (value) {
          const col = cell.col >= 0 ? cell.col : row.cells.length;
          if (col < 1000) {
            while (row.cells.length < col) row.cells.push('');
            row.cells[col] = value;
            cellCount++;
          }
        }
        cell = null;
      } else if (t.name === 'row' && row) {
        if (row.cells.some((c) => c)) rows.push(row);
        row = null;
        if (cellCount >= maxCells) {
          truncated = true;
          break;
        }
      }
    } else if (cell && mode === 'v') cell.v += t.text;
    else if (cell && mode === 't') cell.inline += t.text;
  }
  return { rows, truncated, cellCount };
}

/** Tabellenzeilen zu Blöcken (~1500 Zeichen), Kopfzeile wird in Folgeblöcken wiederholt. */
export function rowsToBlocks(rows: { r: number; cells: string[] }[], label: string, kind: 'sheet' | 'rows'): TextBlock[] {
  const blocks: TextBlock[] = [];
  if (!rows.length) return blocks;
  const header = rows[0]!.cells.join(' | ');
  let buf: string[] = [];
  let start = rows[0]!.r;
  let end = start;
  const flush = () => {
    if (!buf.length) return;
    const withHeader = blocks.length > 0 ? [header, ...buf] : buf;
    blocks.push({
      text: (label && kind === 'sheet' ? `[${label}]\n` : '') + withHeader.join('\n'),
      role: 'table',
      loc: { kind, index: start, end, label: label || undefined },
    });
    buf = [];
  };
  let size = 0;
  for (const row of rows) {
    const line = row.cells.join(' | ').replace(/( \| )+$/, '');
    if (size + line.length > 1500 && buf.length) {
      flush();
      size = 0;
      start = row.r;
    }
    if (!buf.length) start = row.r;
    buf.push(line);
    size += line.length + 1;
    end = row.r;
  }
  flush();
  return blocks;
}

export const xlsxExtractor: Extractor = {
  id: 'xlsx',
  canHandle: ({ kind }) => kind === 'xlsx',
  async extract(input, limits) {
    const parts = await readZipParts(
      input.path,
      (n) =>
        n === 'xl/workbook.xml' ||
        n === 'xl/_rels/workbook.xml.rels' ||
        n === 'xl/sharedStrings.xml' ||
        /^xl\/worksheets\/[^/]+\.xml$/.test(n),
      limits.maxPartBytes,
    );
    const wb = str(parts.get('xl/workbook.xml'));
    if (!wb) throw codedError('XLSX ohne xl/workbook.xml (beschädigt?)', 'office_corrupt');
    const rels = parseRels(str(parts.get('xl/_rels/workbook.xml.rels')), 'xl');
    const shared = parseSharedStrings(str(parts.get('xl/sharedStrings.xml')));
    const sheets: { name: string; target: string }[] = [];
    for (const t of tokenize(wb)) {
      if (t.type === 'open' && t.name === 'sheet') {
        const rel = rels.get(t.attrs['r:id'] ?? '');
        if (rel) sheets.push({ name: t.attrs.name ?? `Sheet${sheets.length + 1}`, target: rel.target });
      }
    }
    const blocks: TextBlock[] = [];
    const warnings: string[] = [];
    let budget = limits.maxCells;
    for (const sheet of sheets) {
      const xml = str(parts.get(sheet.target));
      if (!xml || budget <= 0) continue;
      const parsed = parseSheetXml(xml, shared, budget);
      budget -= parsed.cellCount;
      if (parsed.truncated) warnings.push('truncated');
      blocks.push(...rowsToBlocks(parsed.rows, sheet.name, 'sheet'));
    }
    return { blocks, meta: { pages: sheets.length }, warnings };
  },
};

/* ---------------------------------------------------------------- ODF (odt/odp/ods) */

export function parseOdfContent(xml: string, kind: 'odt' | 'odp' | 'ods', maxCells: number): ExtractResult {
  const blocks: TextBlock[] = [];
  const headingStack: string[] = [];
  let para: { text: string; level: number } | null = null;
  let paraDepth = 0;
  let slide = 0;
  let slideTitle = '';
  let inTitleFrame = false;
  let inNotes = false;
  let sheetName = '';
  let sheetRows: { r: number; cells: string[] }[] = [];
  let rowNo = 0;
  let row: string[] | null = null;
  let cell: string | null = null;
  let cellRepeat = 1;
  let cells = 0;
  const slideBody: string[] = [];
  const slideNotes: string[] = [];

  const flushSlide = () => {
    if (!slide) return;
    const text = [slideTitle, ...slideBody].filter(Boolean).join('\n');
    if (text) blocks.push({ text, heading: slideTitle || undefined, loc: { kind: 'slide', index: slide } });
    if (slideNotes.length) blocks.push({ text: slideNotes.join('\n'), heading: slideTitle || undefined, role: 'notes', loc: { kind: 'slide', index: slide } });
    slideBody.length = 0;
    slideNotes.length = 0;
    slideTitle = '';
  };

  for (const t of tokenize(xml)) {
    if (t.type === 'open') {
      if ((t.name === 'text:p' || t.name === 'text:h') && !t.selfClosing) {
        if (paraDepth === 0) para = { text: '', level: t.name === 'text:h' ? Number(t.attrs['text:outline-level'] ?? 1) || 1 : 0 };
        paraDepth++;
      } else if (t.name === 'text:s' && para) para.text += ' '.repeat(Math.min(Number(t.attrs['text:c'] ?? 1) || 1, 20));
      else if (t.name === 'text:tab' && para) para.text += '\t';
      else if (t.name === 'text:line-break' && para) para.text += '\n';
      else if (t.name === 'draw:page') {
        flushSlide();
        slide++;
      } else if (t.name === 'draw:frame' && t.attrs['presentation:class'] === 'title') inTitleFrame = !t.selfClosing;
      else if (t.name === 'presentation:notes') inNotes = !t.selfClosing;
      else if (t.name === 'table:table' && kind === 'ods') {
        sheetName = t.attrs['table:name'] ?? `Tabelle${blocks.length + 1}`;
        sheetRows = [];
        rowNo = 0;
      } else if (t.name === 'table:table-row') {
        rowNo += 1;
        row = t.selfClosing ? null : [];
        // leere wiederholte Zeilen (oft 1 Mio.) nur zählen, nie expandieren
        const rep = Number(t.attrs['table:number-rows-repeated'] ?? 1);
        if (rep > 1) rowNo += Math.min(rep, 2_000_000) - 1;
      } else if (t.name === 'table:table-cell' || t.name === 'table:covered-table-cell') {
        cellRepeat = Math.min(Number(t.attrs['table:number-columns-repeated'] ?? 1) || 1, 50);
        cell = t.selfClosing ? null : '';
        if (t.selfClosing && row) for (let i = 0; i < cellRepeat; i++) row.push('');
      }
    } else if (t.type === 'close') {
      if (t.name === 'text:p' || t.name === 'text:h') {
        paraDepth = Math.max(0, paraDepth - 1);
        if (paraDepth > 0 || !para) continue;
        const text = para.text.replace(/[ \t]+/g, ' ').trim();
        if (text) {
          if (cell !== null) cell += (cell ? ' ' : '') + text;
          else if (kind === 'odp') {
            if (inNotes) slideNotes.push(text);
            else if (inTitleFrame) slideTitle = [slideTitle, text].filter(Boolean).join(' – ');
            else slideBody.push(text);
          } else if (para.level > 0) {
            headingStack.length = para.level - 1;
            headingStack[para.level - 1] = text;
            blocks.push({ text, heading: headingStack.filter(Boolean).join(' › '), role: 'heading', loc: { kind: 'section' } });
          } else {
            blocks.push({ text, heading: headingStack.filter(Boolean).join(' › ') || undefined, loc: { kind: 'section' } });
          }
        }
        para = null;
      } else if (t.name === 'draw:frame') inTitleFrame = false;
      else if (t.name === 'presentation:notes') inNotes = false;
      else if (t.name === 'table:table-cell' || t.name === 'table:covered-table-cell') {
        if (row && cell !== null) {
          for (let i = 0; i < (cell ? cellRepeat : Math.min(cellRepeat, 1)); i++) row.push(cell);
          if (cell) cells++;
        }
        cell = null;
      } else if (t.name === 'table:table-row') {
        if (row && row.some((c) => c)) {
          while (row.length && !row[row.length - 1]) row.pop();
          if (kind === 'ods') sheetRows.push({ r: rowNo, cells: row });
          else blocks.push({ text: row.join(' | '), role: 'table', heading: headingStack.filter(Boolean).join(' › ') || undefined, loc: kind === 'odp' ? { kind: 'slide', index: slide } : { kind: 'section' } });
        }
        row = null;
        if (cells >= maxCells) break;
      } else if (t.name === 'table:table' && kind === 'ods') {
        blocks.push(...rowsToBlocks(sheetRows, sheetName, 'sheet'));
        sheetRows = [];
      }
    } else if (t.type === 'text' && para) {
      para.text += t.text;
    }
  }
  if (kind === 'ods' && sheetRows.length) blocks.push(...rowsToBlocks(sheetRows, sheetName, 'sheet'));
  flushSlide();
  return { blocks, meta: kind === 'odp' ? { pages: slide } : {}, warnings: cells >= maxCells ? ['truncated'] : [] };
}

export const odfExtractor: Extractor = {
  id: 'odf',
  canHandle: ({ kind }) => kind === 'odt' || kind === 'odp' || kind === 'ods',
  async extract(input, limits) {
    const parts = await readZipParts(input.path, (n) => n === 'content.xml', limits.maxPartBytes);
    const content = str(parts.get('content.xml'));
    if (!content) throw codedError('OpenDocument ohne content.xml (beschädigt?)', 'office_corrupt');
    return parseOdfContent(content, input.kind as 'odt' | 'odp' | 'ods', limits.maxCells);
  },
};

