import { MAX_PDF_IMAGE_PIXELS } from '../ingest/extractors/pdf.ts';

/** Bildobjekt, wie pdf.js es ohne Canvas liefert (kind: 1 = 1 Bit Grau, 2 = RGB, 3 = RGBA; Masken ohne kind). */
export interface PdfJsImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray | null;
}

/**
 * pdf.js-Bild -> 8-Bit-Pixel. 1-Bit-Daten (Graustufen-1BPP und Masken) sind zeilenweise gepackt (MSB zuerst,
 * Zeilen auf volle Bytes aufgefüllt). pdf.js normalisiert beide so, dass ein gesetztes Bit „weiß/nicht gemalt“ ist:
 * Bit 1 -> 255, Bit 0 -> 0 (schwarze Schrift auf weißem Grund). null = nicht verwertbar.
 */
export function toPixels(img: PdfJsImage, mask: boolean): { data: Uint8Array | Uint8ClampedArray; channels: 1 | 3 | 4 } | null {
  const { width: w, height: h, data } = img;
  if (!data || !(w > 0) || !(h > 0) || w * h > MAX_PDF_IMAGE_PIXELS) return null;
  const rowBytes = (w + 7) >> 3;
  if (mask || img.kind === 1) {
    if (data.length < rowBytes * h) return null;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < w; x++) out[y * w + x] = (data[row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
    }
    return { data: out, channels: 1 };
  }
  const channels = data.length / (w * h);
  if (channels === 1 || channels === 3 || channels === 4) return { data, channels };
  return null;
}
