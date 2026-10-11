import { Transform, type Readable } from 'node:stream';
import yauzl from 'yauzl';

/**
 * Sicheres Lesen von ZIP-Archiven (auch OOXML-Container).
 * - Zip-Slip: yauzl verwirft absolute Pfade, "..", Laufwerksbuchstaben; zusätzlich entpacken wir NIE
 *   anhand von Eintragsnamen ins Dateisystem (Content-Addressed-Store).
 * - Zip-Bombe: Vorabprüfung (Anzahl, deklarierte Größen, Kompressionsrate) UND harte Zählung der
 *   tatsächlich entpackten Bytes während des Streamens (Header können lügen).
 */

export interface ZipLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  /** max. Kompressionsrate für Einträge > 10 MB */
  maxRatio: number;
}

export class ZipSecurityError extends Error {
  readonly code: 'zip_unsafe_path' | 'zip_limits' | 'zip_bomb' | 'zip_invalid';
  constructor(code: ZipSecurityError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
  isSymlink: boolean;
  encrypted: boolean;
  raw: yauzl.Entry;
}

export interface OpenedZip {
  entries: ZipEntry[];
  openStream(entry: ZipEntry, maxBytes: number): Promise<Readable>;
  close(): void;
}

function mapYauzlError(err: Error): ZipSecurityError {
  const msg = err.message || String(err);
  if (/absolute path|invalid relative path|invalid characters/i.test(msg)) {
    return new ZipSecurityError('zip_unsafe_path', `Unsicherer Pfad im Archiv (Zip-Slip): ${msg}`);
  }
  if (/too many bytes|too few bytes|compressed size|uncompressed size/i.test(msg)) {
    return new ZipSecurityError('zip_bomb', `Inkonsistente Größenangaben im Archiv: ${msg}`);
  }
  return new ZipSecurityError('zip_invalid', `Archiv nicht lesbar: ${msg}`);
}

export function openZip(path: string, limits: ZipLimits): Promise<OpenedZip> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: false, validateEntrySizes: true },
      (err, zipfile) => {
        if (err || !zipfile) {
          reject(mapYauzlError(err ?? new Error('unbekannt')));
          return;
        }
        const entries: ZipEntry[] = [];
        let declaredTotal = 0;
        let failed = false;
        const fail = (e: Error) => {
          if (failed) return;
          failed = true;
          zipfile.close();
          reject(e);
        };
        zipfile.on('error', (e: Error) => fail(e instanceof ZipSecurityError ? e : mapYauzlError(e)));
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entries.length >= limits.maxEntries) {
            fail(new ZipSecurityError('zip_limits', `Archiv enthält mehr als ${limits.maxEntries} Einträge`));
            return;
          }
          const isDir = entry.fileName.endsWith('/');
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          const e: ZipEntry = {
            name: entry.fileName,
            size: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            isDir,
            isSymlink: mode === 0o120000,
            encrypted: entry.isEncrypted(),
            raw: entry,
          };
          if (!isDir) {
            declaredTotal += e.size;
            if (declaredTotal > limits.maxTotalBytes) {
              fail(new ZipSecurityError('zip_bomb', `Entpackte Gesamtgröße überschreitet ${fmtMB(limits.maxTotalBytes)}`));
              return;
            }
            if (e.size > 10 * 1024 * 1024 && e.size / Math.max(1, e.compressedSize) > limits.maxRatio) {
              fail(new ZipSecurityError('zip_bomb', `Verdächtige Kompressionsrate bei "${e.name}"`));
              return;
            }
          }
          entries.push(e);
          zipfile.readEntry();
        });
        zipfile.on('end', () => {
          if (failed) return;
          let total = 0;
          resolve({
            entries,
            close: () => zipfile.close(),
            openStream: (entry, maxBytes) =>
              new Promise<Readable>((res, rej) => {
                zipfile.openReadStream(entry.raw, (e2, stream) => {
                  if (e2 || !stream) {
                    rej(mapYauzlError(e2 ?? new Error('Stream fehlgeschlagen')));
                    return;
                  }
                  let seen = 0;
                  const limiter = new Transform({
                    transform(chunk: Buffer, _enc, cb) {
                      seen += chunk.length;
                      total += chunk.length;
                      if (seen > maxBytes) cb(new ZipSecurityError('zip_bomb', `Eintrag "${entry.name}" überschreitet ${fmtMB(maxBytes)}`));
                      else if (total > limits.maxTotalBytes) cb(new ZipSecurityError('zip_bomb', `Entpackte Gesamtgröße überschreitet ${fmtMB(limits.maxTotalBytes)}`));
                      else cb(null, chunk);
                    },
                  });
                  stream.on('error', (se: Error) => limiter.destroy(se instanceof ZipSecurityError ? se : mapYauzlError(se)));
                  res(stream.pipe(limiter));
                });
              }),
          });
        });
        zipfile.readEntry();
      },
    );
  });
}

function fmtMB(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
}

/** Liest ausgewählte Teile eines (OOXML/ODF-)Containers in den Speicher – mit Limits. */
export async function readZipParts(
  path: string,
  wanted: (name: string) => boolean,
  maxPartBytes: number,
): Promise<Map<string, Buffer>> {
  const zip = await openZip(path, {
    maxEntries: 20000,
    maxTotalBytes: maxPartBytes * 4,
    maxEntryBytes: maxPartBytes,
    maxRatio: 2000,
  });
  const out = new Map<string, Buffer>();
  try {
    for (const entry of zip.entries) {
      if (entry.isDir || entry.encrypted || !wanted(entry.name)) continue;
      if (entry.size > maxPartBytes) throw new ZipSecurityError('zip_bomb', `Teil "${entry.name}" zu groß`);
      out.set(entry.name, await streamToBuffer(await zip.openStream(entry, maxPartBytes)));
    }
  } finally {
    zip.close();
  }
  return out;
}
