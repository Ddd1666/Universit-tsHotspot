/**
 * Kleine, zur Laufzeit generierte Test-Dateien (keine Binär-Fixtures im Repo).
 */
import { zipSync, strToU8 } from 'fflate';

/* ------------------------------------------------------------------ PDF */

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Minimales PDF: jede Seite = Liste von Zeilen ('' = Leerzeile/Absatz). WinAnsi-Kodierung (Umlaute ok). */
export function makePdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 11 Tf', '14 TL', '72 760 Td'];
    for (const line of lines) {
      if (line) ops.push(`(${pdfEscape(line)}) Tj T*`);
      else ops.push('T*');
    }
    ops.push('ET');
    const stream = ops.join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* ------------------------------------------------------------------ ZIP / OOXML */

export function makeZip(entries: Record<string, string | Uint8Array>, level: 0 | 6 | 9 = 6): Buffer {
  const files: Record<string, [Uint8Array, { level: 0 | 6 | 9 }]> = {};
  for (const [name, data] of Object.entries(entries)) files[name] = [typeof data === 'string' ? strToU8(data) : data, { level }];
  return Buffer.from(zipSync(files));
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface DocxPara {
  text: string;
  style?: 'Heading1' | 'Heading2';
  pageBreakBefore?: boolean;
}

export function makeDocx(paras: DocxPara[], table?: string[][]): Buffer {
  const body = paras
    .map((p) => {
      const pPr = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : '';
      const br = p.pageBreakBefore ? '<w:r><w:lastRenderedPageBreak/></w:r>' : '';
      return `<w:p>${pPr}${br}<w:r><w:t xml:space="preserve">${xmlEsc(p.text)}</w:t></w:r></w:p>`;
    })
    .join('');
  const tbl = table
    ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p><w:r><w:t>${xmlEsc(c)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
    : '';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}${tbl}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': doc,
    'word/styles.xml': styles,
  });
}

export interface Slide {
  title: string;
  body: string[];
  notes?: string;
}

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function shapeXml(text: string[], ph?: string): string {
  const phXml = ph ? `<p:nvPr><p:ph type="${ph}"/></p:nvPr>` : '<p:nvPr/>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="1" name="s"/><p:cNvSpPr/>${phXml}</p:nvSpPr><p:txBody>${text
    .map((t) => `<a:p><a:r><a:t>${xmlEsc(t)}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;
}

/** PPTX; `order` erlaubt eine von der Dateinummer abweichende Folienreihenfolge. */
export function makePptx(slides: Slide[], order?: number[]): Buffer {
  const files: Record<string, string> = {};
  const seq = order ?? slides.map((_, i) => i);
  files['ppt/presentation.xml'] = `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL_TYPE}"><p:sldIdLst>${seq
    .map((i, n) => `<p:sldId id="${256 + n}" r:id="rId${i + 10}"/>`)
    .join('')}</p:sldIdLst></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${slides
    .map((_, i) => `<Relationship Id="rId${i + 10}" Type="${REL_TYPE}/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join('')}</Relationships>`;
  slides.forEach((s, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] =
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
      shapeXml([s.title], 'title') +
      shapeXml(s.body) +
      shapeXml([String(n)], 'sldNum') +
      `</p:spTree></p:cSld></p:sld>`;
    if (s.notes) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}"><Relationship Id="rId2" Type="${REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      files[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
        shapeXml([], 'sldImg') +
        shapeXml([s.notes], 'body') +
        shapeXml([String(n)], 'sldNum') +
        `</p:spTree></p:cSld></p:notes>`;
    }
  });
  return makeZip(files);
}

export function makeXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const shared: string[] = [];
  const sIndex = (s: string) => {
    let i = shared.indexOf(s);
    if (i === -1) {
      shared.push(s);
      i = shared.length - 1;
    }
    return i;
  };
  const files: Record<string, string> = {};
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map(
        (row, r) =>
          `<row r="${r + 1}">${row
            .map((v, c) => {
              const ref = String.fromCharCode(65 + c) + (r + 1);
              return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${sIndex(v)}</v></c>`;
            })
            .join('')}</row>`,
      )
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL_TYPE}"><sheets>${sheets
    .map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="${RELS_NS}">${sheets
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
    .map((s) => `<si><t>${xmlEsc(s)}</t></si>`)
    .join('')}</sst>`;
  return makeZip(files);
}

export function makeOdt(paras: { text: string; heading?: number }[]): Buffer {
  const body = paras
    .map((p) => (p.heading ? `<text:h text:outline-level="${p.heading}">${xmlEsc(p.text)}</text:h>` : `<text:p>${xmlEsc(p.text)}</text:p>`))
    .join('');
  return makeZip({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  });
}

/** ZIP-Header manipulieren: deklarierte (unkomprimierte) Größe aller Einträge auf `size` setzen ("lügende" Header). */
export function patchZipDeclaredSizes(zip: Buffer, size: number): Buffer {
  const b = Buffer.from(zip);
  for (let i = 0; i < b.length - 4; i++) {
    const sig = b.readUInt32LE(i);
    if (sig === 0x04034b50) b.writeUInt32LE(size, i + 22);
    else if (sig === 0x02014b50) b.writeUInt32LE(size, i + 24);
  }
  return b;
}
