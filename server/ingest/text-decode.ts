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

/** Steuerzeichen entfernen, Zeilenenden normalisieren (CRLF -> LF). */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00ad/g, '')
    .replace(/[ \t\u00a0]+\n/g, '\n');
}
