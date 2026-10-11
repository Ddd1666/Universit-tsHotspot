import { describe, expect, it } from 'vitest';
import { chunkBlocks, CHARS_PER_TOKEN, estimateTokens, locationLabel, splitSentences } from '../server/ingest/chunker.ts';
import type { TextBlock } from '../server/ingest/types.ts';

const sentence = (i: number) => `Satz Nummer ${i} beschreibt einen wichtigen Zusammenhang der Thermodynamik und Entropie.`;
const paragraph = (n: number, start = 0) => Array.from({ length: n }, (_, i) => sentence(start + i)).join(' ');

describe('Chunking', () => {
  it('hält Zielgröße ein (≈600 Token, max. 800) und verliert keinen Text', () => {
    const blocks: TextBlock[] = Array.from({ length: 30 }, (_, p) => ({ text: paragraph(8, p * 8), loc: { kind: 'page', index: p + 1 } }));
    const chunks = chunkBlocks(blocks);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.tokenEst).toBeLessThanOrEqual(800 + 70); // + Überlappung
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
    // jeder Satz kommt mindestens einmal vor
    const all = chunks.map((c) => c.text).join('\n');
    for (let i = 0; i < 240; i++) expect(all).toContain(`Satz Nummer ${i} `);
  });

  it('übernimmt Seitenbereiche und überlappt fortlaufenden Text', () => {
    const blocks: TextBlock[] = Array.from({ length: 6 }, (_, p) => ({ text: paragraph(10, p * 10), loc: { kind: 'page', index: p + 1 } }));
    const chunks = chunkBlocks(blocks);
    expect(chunks[0]!.locKind).toBe('page');
    expect(chunks[0]!.locStart).toBe(1);
    expect(chunks.at(-1)!.locEnd).toBe(6);
    // Überlappung: Ende von Chunk n taucht am Anfang von Chunk n+1 auf
    const tail = chunks[0]!.text.slice(-60);
    expect(chunks[1]!.text.includes(tail.slice(-40))).toBe(true);
  });

  it('respektiert Tabellenblatt-Grenzen hart und überlappt Folien nicht', () => {
    const chunks = chunkBlocks([
      { text: 'Kopf | Wert\nA | 1', role: 'table', loc: { kind: 'sheet', label: 'Blatt1', index: 1, end: 2 } },
      { text: 'Kopf | Wert\nB | 2', role: 'table', loc: { kind: 'sheet', label: 'Blatt2', index: 1, end: 2 } },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.locLabel)).toEqual(['Blatt1', 'Blatt2']);

    const slides = chunkBlocks(Array.from({ length: 12 }, (_, i) => ({ text: paragraph(6, i * 6), loc: { kind: 'slide' as const, index: i + 1 }, heading: `Folie ${i + 1}` })));
    for (let i = 1; i < slides.length; i++) {
      const prevLast = slides[i - 1]!.text.split('\n\n').at(-1)!;
      expect(slides[i]!.text.startsWith(prevLast)).toBe(false);
    }
  });

  it('teilt überlange Absätze an Satzgrenzen bzw. hart', () => {
    const huge = paragraph(200);
    const chunks = chunkBlocks([{ text: huge }]);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800 * CHARS_PER_TOKEN + 10);
    const noSpaces = 'x'.repeat(10_000);
    const hard = chunkBlocks([{ text: noSpaces }]);
    expect(hard.reduce((n, c) => n + c.text.length, 0)).toBeGreaterThanOrEqual(10_000);
  });

  it('beginnt bei Überschriften einen neuen Chunk (wenn groß genug) und setzt Abschnitt', () => {
    const chunks = chunkBlocks([
      { text: 'Einleitung', role: 'heading', heading: 'Einleitung' },
      { text: paragraph(6), heading: 'Einleitung' },
      { text: 'Methoden', role: 'heading', heading: 'Methoden' },
      { text: paragraph(6, 50), heading: 'Methoden' },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.heading).toBe('Methoden');
    expect(chunks[1]!.text.startsWith('Methoden')).toBe(true);
  });

  it('Hilfsfunktionen', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(splitSentences('Erster Satz. Zweiter Satz! Dritter?')).toHaveLength(3);
    expect(locationLabel({ locKind: 'page', locStart: 3, locEnd: 4, locLabel: null })).toBe('page 3-4');
    expect(locationLabel({ locKind: 'sheet', locStart: 2, locEnd: 9, locLabel: 'Daten' })).toBe('sheet "Daten", rows 2-9');
  });
});
