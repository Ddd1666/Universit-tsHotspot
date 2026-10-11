import type { ExtractInput, Extractor } from '../types.ts';
import { pdfExtractor } from './pdf.ts';
import { docxExtractor, pptxExtractor, xlsxExtractor, odfExtractor } from './office.ts';
import { textExtractor, csvExtractor, htmlExtractor } from './plain.ts';

/**
 * Registrierte Extractor (Reihenfolge = Priorität).
 * Phase 2: hier z. B. `imageOcrExtractor` (Vision/OCR) und `mediaTranscriptExtractor` (whisper.cpp) ergänzen.
 */
export const EXTRACTORS: Extractor[] = [
  pdfExtractor,
  docxExtractor,
  pptxExtractor,
  xlsxExtractor,
  odfExtractor,
  csvExtractor,
  htmlExtractor,
  textExtractor,
];

export function findExtractor(input: Pick<ExtractInput, 'kind' | 'ext' | 'mime'>): Extractor | null {
  return EXTRACTORS.find((e) => e.canHandle(input)) ?? null;
}
