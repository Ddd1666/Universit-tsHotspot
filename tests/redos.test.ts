import { describe, expect, it } from 'vitest';
import { htmlToBlocks, parseMdHeading, textToBlocks, parseCsv } from '../server/ingest/extractors/plain.ts';
import { normalizeText } from '../server/ingest/text-decode.ts';
import { tokenize } from '../server/ingest/xml.ts';
import { itemsToParagraphs } from '../server/ingest/extractors/pdf.ts';
import { chunkBlocks } from '../server/ingest/chunker.ts';

/** Präparierte Eingaben dürfen keine (super-)lineare Laufzeit auslösen (ReDoS). */
function timed(fn: () => unknown): number {
  const t = performance.now();
  fn();
  return performance.now() - t;
}

const LIMIT_MS = 1500; // großzügig für langsame Rechner; die alten Regexe brauchten hier Sekunden bis Minuten

describe('ReDoS-Schutz bei präparierten Dateien', () => {
  it('Markdown-Überschrift mit tausenden Leerzeichen (früher kubisch: 4000 Leerzeichen ≈ 10 s)', () => {
    const line = '#' + ' '.repeat(4000) + 'x' + ' '.repeat(4000) + '#'.repeat(50) + ' '.repeat(4000) + '!';
    const md = Array.from({ length: 20 }, () => line).join('\n');
    expect(timed(() => textToBlocks(md, { markdown: true }))).toBeLessThan(LIMIT_MS);
    expect(parseMdHeading('## Titel ##')).toEqual({ level: 2, text: 'Titel' });
    expect(parseMdHeading('#Kein Titel')).toBeNull();
    expect(parseMdHeading('####### zu tief')).toBeNull();
    expect(parseMdHeading('# C# ist toll')).toEqual({ level: 1, text: 'C# ist toll' });
  });

  it('lange Leerzeichenfolgen ohne Zeilenumbruch (früher quadratisch)', () => {
    const s = ' '.repeat(300_000) + 'x' + ' \t'.repeat(100_000) + 'y';
    expect(timed(() => normalizeText(s))).toBeLessThan(LIMIT_MS);
    expect(normalizeText('a  \t\nb \r\nc')).toBe('a\nb\nc');
  });

  it('HTML: offene Tags, Kommentare und Skripte ohne Ende', () => {
    const cases = ['<a'.repeat(100_000), '<!--'.repeat(80_000), '<script>'.repeat(50_000) + 'x', '<div ' + 'a'.repeat(400_000), '<td>'.repeat(60_000) + 'Text'];
    for (const html of cases) expect(timed(() => htmlToBlocks(html)), html.slice(0, 10)).toBeLessThan(LIMIT_MS);
    const ok = htmlToBlocks('<p>a < b und c > d</p><script>evil()</script><p>Ende</p>');
    expect(ok.blocks.map((b) => b.text)).toEqual(['a < b und c > d', 'Ende']);
  });

  it('XML: riesiges Tag ohne Attribute-Ende', () => {
    const xml = '<w:p ' + 'a'.repeat(400_000) + '><w:t>Hallo</w:t></w:p>';
    expect(timed(() => [...tokenize(xml)])).toBeLessThan(LIMIT_MS);
  });

  it('PDF-Absatz mit sehr vielen Zeilen (Silbentrennungs-Prüfung linear)', () => {
    const items = Array.from({ length: 30_000 }, (_, i) => ({ str: `Zeile ${i} mit Wort-`, hasEOL: true, transform: [0, 0, 0, 0, 0, 1000 - i * 0.01] }));
    expect(timed(() => itemsToParagraphs(items))).toBeLessThan(LIMIT_MS);
  });

  it('CSV mit offenem Anführungszeichen und Chunking großer Blöcke', () => {
    expect(timed(() => parseCsv('"' + 'a,'.repeat(300_000), ','))).toBeLessThan(LIMIT_MS);
    expect(timed(() => chunkBlocks([{ text: 'Wort. '.repeat(200_000) }]))).toBeLessThan(LIMIT_MS * 2);
  });
});
