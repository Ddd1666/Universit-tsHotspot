import { describe, expect, it } from 'vitest';
import { runExtraction } from '../server/ingest/extract-run.ts';
import { detectKind, unsupportedReason } from '../server/ingest/detect.ts';
import { DEFAULT_EXTRACT_LIMITS, type ExtractInput, type SourceKind } from '../server/ingest/types.ts';
import { findExtractor } from '../server/ingest/extractors/registry.ts';
import { pdfExtractor, itemsToParagraphs } from '../server/ingest/extractors/pdf.ts';
import { docxExtractor, pptxExtractor, xlsxExtractor, odfExtractor } from '../server/ingest/extractors/office.ts';
import { csvExtractor, htmlExtractor, textExtractor, parseCsv } from '../server/ingest/extractors/plain.ts';
import { decodeText } from '../server/ingest/text-decode.ts';
import { makeDocx, makeOdt, makePdf, makePptx, makeXlsx } from './fixtures.ts';
import { tmpDir, writeTmp } from './helpers.ts';

const dir = tmpDir('extract');

function input(name: string, data: Buffer | string): ExtractInput {
  const p = writeTmp(dir, name, data);
  const head = Buffer.isBuffer(data) ? data.subarray(0, 8192) : Buffer.from(data).subarray(0, 8192);
  const det = detectKind(name, head);
  return { path: p, name, ext: det.ext, mime: det.mime, kind: det.kind };
}

describe('Formaterkennung', () => {
  it('erkennt Formate über Magic Bytes und Endung', () => {
    expect(detectKind('x.pdf', makePdf([['a']])).kind).toBe('pdf');
    expect(detectKind('falsch.txt', makePdf([['a']])).kind).toBe('pdf'); // Inhalt schlägt Endung
    expect(detectKind('a.docx', makeDocx([{ text: 'x' }])).kind).toBe('docx');
    expect(detectKind('a.zip', makeDocx([{ text: 'x' }])).kind).toBe('zip');
    expect(detectKind('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).kind).toBe('image');
    expect(detectKind('a.mp3', Buffer.from('ID3....')).kind).toBe('audio');
    expect(detectKind('alt.doc', Buffer.from('d0cf11e0a1b11ae1', 'hex')).kind).toBe('legacy-office');
    expect(detectKind('script.py', Buffer.from('print("hi")\n')).kind).toBe('code');
    expect(detectKind('README', Buffer.from('Hallo Welt')).kind).toBe('text');
    expect(detectKind('blob.bin', Buffer.from([0, 1, 2, 3, 0, 0])).kind).toBe('other');
    expect(detectKind('kaputt.docx', Buffer.from('kein zip')).kind).toBe('other');
  });

  it('passwortgeschützte DOCX/XLSX/PPTX werden als verschlüsselt erkannt (nicht als altes Office-Format)', () => {
    const ole = Buffer.from('d0cf11e0a1b11ae1000000', 'hex');
    for (const name of ['geheim.docx', 'geheim.xlsx', 'geheim.pptx']) {
      const d = detectKind(name, ole);
      expect(d.kind, name).toBe('encrypted-office');
      expect(unsupportedReason(d.kind)).toBe('encrypted_office');
    }
    expect(unsupportedReason(detectKind('alt.xls', ole).kind)).toBe('legacy_office');
  });

  it('hat für Bilder/Audio/Video bewusst keinen Extractor (Phase 2)', () => {
    for (const kind of ['image', 'audio', 'video', 'other', 'legacy-office'] as SourceKind[]) {
      expect(findExtractor({ kind, ext: '', mime: '' })).toBeNull();
    }
  });
});

describe('PDF', () => {
  it('liefert Text mit Seitenzahlen, Umlauten und repariert Silbentrennung', async () => {
    const pdf = makePdf([
      ['Kapitel 1: Lineare Algebra', '', 'Vektoren sind Elemente eines Vek-', 'torraums. Größe und Übung!'],
      ['Seite zwei: Matrizen (Matrix) und Determinanten.'],
    ]);
    const r = await pdfExtractor.extract(input('skript.pdf', pdf), DEFAULT_EXTRACT_LIMITS);
    expect(r.meta?.pages).toBe(2);
    const p1 = r.blocks.filter((b) => b.loc?.index === 1).map((b) => b.text).join('\n');
    const p2 = r.blocks.filter((b) => b.loc?.index === 2).map((b) => b.text).join('\n');
    expect(p1).toContain('Vektorraums');
    expect(p1).toContain('Größe und Übung');
    expect(p2).toContain('Matrizen (Matrix)');
    expect(r.blocks.every((b) => b.loc?.kind === 'page')).toBe(true);
  });

  it('markiert PDFs ohne Text (Scan) statt zu scheitern', async () => {
    const out = await runExtraction(input('scan.pdf', makePdf([[], []])), DEFAULT_EXTRACT_LIMITS);
    expect(out.chunks).toHaveLength(0);
    expect(out.warnings).toContain('no_text');
  });

  it('meldet beschädigte PDFs als Fehler', async () => {
    await expect(pdfExtractor.extract(input('kaputt.pdf', '%PDF-1.4 kaputt'), DEFAULT_EXTRACT_LIMITS)).rejects.toThrow(/PDF/);
  });

  it('Absatz-Heuristik trennt bei großem Zeilenabstand', () => {
    const paras = itemsToParagraphs([
      { str: 'Zeile eins', hasEOL: true, transform: [0, 0, 0, 0, 0, 700] },
      { str: 'Zeile zwei', hasEOL: true, transform: [0, 0, 0, 0, 0, 686] },
      { str: 'Neuer Absatz', hasEOL: true, transform: [0, 0, 0, 0, 0, 640] },
      { str: 'weiter', hasEOL: true, transform: [0, 0, 0, 0, 0, 626] },
    ]);
    expect(paras).toEqual(['Zeile eins Zeile zwei', 'Neuer Absatz weiter']);
  });
});

describe('DOCX', () => {
  it('extrahiert Absätze, Überschriften-Kontext, Tabellen und Seitenhinweise', async () => {
    const docx = makeDocx(
      [
        { text: 'Einleitung', style: 'Heading1' },
        { text: 'Dies ist der erste Absatz über Thermodynamik.' },
        { text: 'Grundlagen', style: 'Heading2' },
        { text: 'Zweiter Absatz <mit> & Sonderzeichen.', pageBreakBefore: true },
      ],
      [
        ['Begriff', 'Definition'],
        ['Entropie', 'Maß für Unordnung'],
      ],
    );
    const r = await docxExtractor.extract(input('arbeit.docx', docx), DEFAULT_EXTRACT_LIMITS);
    const body = r.blocks.find((b) => b.text.startsWith('Zweiter'))!;
    expect(body.text).toBe('Zweiter Absatz <mit> & Sonderzeichen.');
    expect(body.heading).toBe('Einleitung › Grundlagen');
    expect(body.loc).toEqual({ kind: 'page', index: 2 });
    const table = r.blocks.find((b) => b.role === 'table')!;
    expect(table.text).toContain('Entropie | Maß für Unordnung');
  });
});

describe('PPTX', () => {
  it('liefert Folien in Präsentationsreihenfolge mit Titel, Text, Notizen und Foliennummer', async () => {
    const pptx = makePptx(
      [
        { title: 'Titel A', body: ['Punkt A1', 'Punkt A2'], notes: 'Sprechernotiz zu A' },
        { title: 'Titel B', body: ['Punkt B1'] },
      ],
      [1, 0], // Datei 2 ist Folie 1
    );
    const r = await pptxExtractor.extract(input('vortrag.pptx', pptx), DEFAULT_EXTRACT_LIMITS);
    expect(r.meta?.pages).toBe(2);
    const slide1 = r.blocks.find((b) => b.loc?.index === 1 && b.role !== 'notes')!;
    expect(slide1.heading).toBe('Titel B');
    expect(slide1.text).toContain('Punkt B1');
    const notes = r.blocks.find((b) => b.role === 'notes')!;
    expect(notes.loc).toEqual({ kind: 'slide', index: 2 });
    expect(notes.text).toBe('Sprechernotiz zu A');
    // Foliennummer-Platzhalter wird nicht als Inhalt übernommen
    expect(r.blocks.some((b) => /^\d+$/.test(b.text))).toBe(false);
  });
});

describe('XLSX / CSV', () => {
  it('XLSX: Tabellenblätter mit Namen, Shared Strings, Zahlen und Zeilenbereich', async () => {
    const xlsx = makeXlsx([
      { name: 'Noten', rows: [['Fach', 'Note'], ['Mathe', 1.7], ['Physik', 2.3]] },
      { name: 'Termine', rows: [['Datum', 'Klausur'], ['12.02.', 'Analysis']] },
    ]);
    const r = await xlsxExtractor.extract(input('daten.xlsx', xlsx), DEFAULT_EXTRACT_LIMITS);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0]!.loc).toEqual({ kind: 'sheet', index: 1, end: 3, label: 'Noten' });
    expect(r.blocks[0]!.text).toContain('Mathe | 1.7');
    expect(r.blocks[1]!.text).toContain('[Termine]');
  });

  it('CSV: erkennt Semikolon, Anführungszeichen und Umbrüche in Feldern', async () => {
    const csv = 'Name;Beschreibung\n"Müller";"Text mit ; Semikolon"\n"Zeile";"mehr\nzeilig"\n';
    const r = await csvExtractor.extract(input('liste.csv', csv), DEFAULT_EXTRACT_LIMITS);
    expect(r.blocks[0]!.text).toContain('Müller | Text mit ; Semikolon');
    expect(r.blocks[0]!.loc?.kind).toBe('rows');
    expect(parseCsv('a,"b ""q""",c', ',').rows[0]).toEqual(['a', 'b "q"', 'c']);
  });
});

describe('Text, Markdown, HTML, Code, JSON, ODF', () => {
  it('Markdown: Überschriften als Abschnittskontext, Zeilennummern, Code-Blöcke bleiben zusammen', async () => {
    const md = '# Kapitel\n\nAbsatz eins.\n\n## Unter\n\n```py\ndef f():\n\n    return 1\n```\n';
    const r = await textExtractor.extract(input('notizen.md', md), DEFAULT_EXTRACT_LIMITS);
    const code = r.blocks.find((b) => b.text.includes('def f'))!;
    expect(code.text).toContain('return 1');
    expect(code.heading).toBe('Kapitel › Unter');
    expect(code.loc).toMatchObject({ kind: 'lines', index: 7 });
  });

  it('lange Texte ohne Leerzeilen: größenbegrenzte Blöcke mit korrekten Zeilenbereichen', async () => {
    const text = Array.from({ length: 20_000 }, (_, i) => `Zeile ${i + 1} mit etwas Text`).join('\n');
    const out = await runExtraction(input('log.txt', text), DEFAULT_EXTRACT_LIMITS);
    expect(out.chunks.length).toBeGreaterThan(50);
    let expectStart = 1;
    for (const c of out.chunks) {
      expect(c.locKind).toBe('lines');
      expect(c.locEnd! - c.locStart!).toBeLessThan(200); // früher: "Zeilen 1–20000" für alles
      expect(c.locStart!).toBeLessThanOrEqual(expectStart + 1);
      expect(c.text).toContain(`Zeile ${c.locStart} mit`);
      expect(c.text).toContain(`Zeile ${c.locEnd} mit`);
      expectStart = c.locEnd! + 1;
    }
    expect(out.chunks.at(-1)!.locEnd).toBe(20_000);
  });

  it('sehr große Textdateien werden nur bis zum Limit indexiert (Warnung), UTF-8 bleibt intakt', async () => {
    const text = 'Übung macht den Meister. '.repeat(400);
    const out = await runExtraction(input('gross.md', text), { ...DEFAULT_EXTRACT_LIMITS, maxTextBytes: 1001 });
    expect(out.warnings).toContain('truncated_text');
    expect(out.chunks.map((c) => c.text).join('')).not.toContain('\ufffd');
    expect(out.chunks.map((c) => c.text).join('').length).toBeLessThan(1001);
  });

  it('dekodiert Windows-1252 (alte Textdateien) und UTF-16 mit BOM', () => {
    expect(decodeText(Buffer.from([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toBe('Größe');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Übung', 'utf16le')]);
    expect(decodeText(utf16)).toBe('Übung');
  });

  it('HTML: Skripte/Styles werden verworfen, Überschriften genutzt', async () => {
    const html = '<html><head><title>Seite</title><style>p{}</style></head><body><h1>Thema</h1><script>alert(1)</script><p>Inhalt &amp; mehr</p></body></html>';
    const r = await htmlExtractor.extract(input('seite.html', html), DEFAULT_EXTRACT_LIMITS);
    const text = r.blocks.map((b) => b.text).join('\n');
    expect(text).toContain('Inhalt & mehr');
    expect(text).not.toContain('alert');
    expect(r.blocks.find((b) => b.text === 'Inhalt & mehr')!.heading).toBe('Thema');
  });

  it('Code, JSON und Jupyter-Notebooks werden als Text indexiert', async () => {
    const py = await runExtraction(input('algo.py', 'def quicksort(a):\n    return a\n'), DEFAULT_EXTRACT_LIMITS);
    expect(py.chunks[0]!.text).toContain('quicksort');
    const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Analyse\n', 'Text'] }, { cell_type: 'code', source: 'x = 1' }] });
    const r = await runExtraction(input('analyse.ipynb', nb), DEFAULT_EXTRACT_LIMITS);
    expect(r.chunks.map((c) => c.text).join(' ')).toContain('x = 1');
  });

  it('ODT: Überschriften und Absätze', async () => {
    const odt = makeOdt([{ text: 'Thema', heading: 1 }, { text: 'Absatz im OpenDocument.' }]);
    const r = await odfExtractor.extract(input('text.odt', odt), DEFAULT_EXTRACT_LIMITS);
    expect(r.blocks.find((b) => b.text.startsWith('Absatz'))!.heading).toBe('Thema');
  });
});
