import fsp from 'node:fs/promises';

/**
 * Text-Dekodierung mit BOM-Erkennung. Ungültiges UTF-8 -> Windows-1252
 * (typisch für ältere deutsche Windows-Textdateien mit Umlauten).
 */
export function decodeText(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

/** Leerzeichen/Tabs am Zeilenende entfernen – linear (ein Regex wie /[ \t]+\n/ wäre bei langen Leerzeichenfolgen quadratisch). */
function trimLineEnd(line: string): string {
  let j = line.length;
  while (j > 0) {
    const c = line.charCodeAt(j - 1);
    if (c === 32 || c === 9 || c === 0xa0) j--;
    else break;
  }
  return j === line.length ? line : line.slice(0, j);
}

/** Steuerzeichen entfernen, Zeilenenden normalisieren (CRLF -> LF). */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00ad/g, '')
    .split('\n')
    .map(trimLineEnd)
    .join('\n');
}

/**
 * Höchstens `maxBytes` einer Textdatei lesen (Speicher-/Zeitgrenze für sehr große Dateien).
 * Schneidet nicht mitten in einem UTF-8-Zeichen ab.
 */
export async function readTextCapped(file: string, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (size <= maxBytes) return { buf, truncated: false };
    let end = len;
    while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--; // Folgebytes
    if (end > 0 && buf[end - 1]! >= 0xc0) end--; // angefangenes Mehrbyte-Zeichen
    if (buf[0] === 0xff || buf[0] === 0xfe) end -= end % 2; // UTF-16
    return { buf: buf.subarray(0, end), truncated: true };
  } finally {
    await fh.close();
  }
}
