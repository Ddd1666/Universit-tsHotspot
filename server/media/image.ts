import zlib from 'node:zlib';

/**
 * Bild-Hilfen ohne native Module: Abmessungen aus dem Dateikopf lesen (Schutz vor Dekompressionsbomben,
 * bevor irgendetwas dekodiert wird) und Rohpixel (aus PDF-Seiten) verkleinern + als PNG kodieren (node:zlib).
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Breite/Höhe aus PNG/JPEG/GIF/BMP/WebP-Kopf; null = unbekannt/defekt. Liest nur die ersten Bytes, linear begrenzt. */
export function imageSize(buf: Buffer): ImageSize | null {
  const at = (o: number, s: string) => buf.length >= o + s.length && buf.subarray(o, o + s.length).toString('latin1') === s;
  if (buf.length >= 24 && buf[0] === 0x89 && at(1, 'PNG') && at(12, 'IHDR')) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (at(0, 'GIF8') && buf.length >= 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (at(0, 'BM') && buf.length >= 26) return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
  if (at(0, 'RIFF') && at(8, 'WEBP') && buf.length >= 30) {
    if (at(12, 'VP8 ')) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (at(12, 'VP8L')) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (at(12, 'VP8X')) return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // JPEG: Segmente bis zum SOF-Marker überspringen (max. 1 MB Kopf durchsuchen)
    let i = 2;
    const end = Math.min(buf.length, 1 << 20);
    while (i + 9 < end) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
        i += marker === 0xff ? 1 : 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** Rohpixel (1/3/4 Kanäle) auf höchstens `maxSide` verkleinern (Box-Mittelung, ganzzahliger Faktor). */
export function downscale(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: number, maxSide: number): { data: Uint8Array | Uint8ClampedArray; width: number; height: number } {
  const factor = Math.ceil(Math.max(width, height) / maxSide);
  if (factor <= 1) return { data, width, height };
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * channels);
  const area = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = ((y * factor + dy) * width + x * factor) * channels + c;
          for (let dx = 0; dx < factor; dx++) sum += data[row + dx * channels]!;
        }
        out[(y * w + x) * channels + c] = Math.round(sum / area);
      }
    }
  }
  return { data: out, width: w, height: h };
}

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}

/** Rohpixel -> PNG (Graustufen, RGB oder RGBA; 8 Bit). */
export function encodePng(data: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 3 | 4): Buffer {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // Filter "None"
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
