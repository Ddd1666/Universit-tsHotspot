// Erzeugt scripts/hotspot.ico (Desktop-Verknüpfung) – ohne Abhängigkeiten, nur node:zlib.
//   node scripts/make-icon.mjs [ziel.ico] [--png ordner]   (--png: jede Größe zusätzlich als PNG zum Ansehen)
// Design aus web/src/styles.css: dunkler Glas-Hintergrund (--bg/--surface-solid), Neon-Rand (--accent),
// Hotspot-Symbol: Punkt + Funkbögen in --accent (#39e6ff), --ok (#3dffa8) und Violett (#b18bff).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG_TOP = [0x0d, 0x14, 0x27];
const BG_BOTTOM = [0x05, 0x07, 0x0f];
const CYAN = [0x39, 0xe6, 0xff];
const GREEN = [0x3d, 0xff, 0xa8];
const VIOLET = [0xb1, 0x8b, 0xff];

const clamp = (v) => Math.max(0, Math.min(1, v));

/** Abstand zum abgerundeten Quadrat (negativ = innen), Koordinaten 0..1 */
function roundRect(x, y, r) {
  const qx = Math.abs(x - 0.5) - (0.5 - r);
  const qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Ebenen (von unten nach oben) als Funktionen (x, y) -> [r, g, b, a] in 0..1-Koordinaten */
function layers(size) {
  const small = size <= 24;
  const m = small ? 0.02 : 0.04; // Rand zum Kachelrand
  const radius = 0.22;
  const border = small ? 0.065 : size <= 48 ? 0.05 : 0.032;
  const cx = 0.5;
  const cy = small ? 0.74 : 0.69;
  const arcs = small
    ? [{ r: 0.28, w: 0.12, c: CYAN }, { r: 0.48, w: 0.12, c: VIOLET }]
    : [{ r: 0.19, w: 0.075, c: CYAN }, { r: 0.31, w: 0.075, c: GREEN }, { r: 0.43, w: 0.075, c: VIOLET }];
  const dot = small ? 0.1 : 0.07;
  const half = Math.PI / 4; // Bögen ±45° um die Senkrechte
  const tile = (x, y) => roundRect((x - m) / (1 - 2 * m), (y - m) / (1 - 2 * m), radius) * (1 - 2 * m);
  return [
    // Kachel: dunkler Verlauf (Glas), oben leicht heller
    (x, y) => {
      const t = clamp(y);
      const c = BG_TOP.map((v, i) => (v + (BG_BOTTOM[i] - v) * t) / 255);
      const shine = clamp(0.5 - y) * 0.12;
      return [c[0] + shine, c[1] + shine, c[2] + shine * 1.3, tile(x, y) <= 0 ? 1 : 0];
    },
    // Glühen des Symbols
    (x, y) => {
      if (small || tile(x, y) > 0) return [0, 0, 0, 0];
      const d = Math.hypot(x - cx, y - cy);
      return [CYAN[0] / 255, CYAN[1] / 255, CYAN[2] / 255, 0.16 * clamp(1 - d / 0.6) ** 2];
    },
    // Neon-Rand
    (x, y) => {
      const d = tile(x, y);
      return [CYAN[0] / 255, CYAN[1] / 255, CYAN[2] / 255, d <= 0 && d > -border ? 1 : 0];
    },
    // Funkbögen + Punkt
    (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= dot) return [...CYAN.map((v) => v / 255), 1];
      const ang = Math.atan2(dx, -dy);
      for (const a of arcs) {
        const inBand = Math.abs(d - a.r) <= a.w / 2 && Math.abs(ang) <= half;
        // runde Enden: Abstand zum nächstgelegenen Bogenende
        const ex = cx + Math.sin((Math.sign(ang) || 1) * half) * a.r;
        const ey = cy - Math.cos(half) * a.r;
        if (inBand || Math.hypot(x - ex, y - ey) <= a.w / 2) return [...a.c.map((v) => v / 255), 1];
      }
      return [0, 0, 0, 0];
    },
  ];
}

/** RGBA-Pixel mit 4×4-Überabtastung (Kantenglättung) */
export function render(size) {
  const ls = layers(size);
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          let cr = 0, cg = 0, cb = 0, ca = 0; // vormultipliziert
          for (const layer of ls) {
            const [lr, lg, lb, la] = layer(x, y);
            if (la <= 0) continue;
            cr = lr * la + cr * (1 - la);
            cg = lg * la + cg * (1 - la);
            cb = lb * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = S * S;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha ? Math.round(clamp(r / n / alpha) * 255) : 0;
      out[i + 1] = alpha ? Math.round(clamp(g / n / alpha) * 255) : 0;
      out[i + 2] = alpha ? Math.round(clamp(b / n / alpha) * 255) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bittiefe
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO mit PNG-Einträgen (seit Windows Vista für alle Größen unterstützt) */
export function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2); // Typ: Icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    header[o] = size >= 256 ? 0 : size;
    header[o + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, o + 4); // Farbebenen
    header.writeUInt16LE(32, o + 6); // Bit pro Pixel
    header.writeUInt32LE(data.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.data)]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const pngIdx = args.indexOf('--png');
  const pngDir = pngIdx >= 0 ? args.splice(pngIdx, 2)[1] : null;
  const target = args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'hotspot.ico');
  const images = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
  fs.writeFileSync(target, ico(images));
  if (pngDir) {
    fs.mkdirSync(pngDir, { recursive: true });
    for (const im of images) fs.writeFileSync(path.join(pngDir, `hotspot-${im.size}.png`), im.data);
  }
  console.log(`Icon geschrieben: ${target} (${SIZES.join(', ')} px)`);
}
