import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { codedError } from '../ingest/types.ts';
import { openZip } from '../ingest/zip.ts';

/**
 * Bestätigter, SHA-256-geprüfter Download der Medien-Werkzeuge in den Projektordner (`tools/`).
 * - Quellen, Hashes und Größen stehen fest im Manifest (scripts/media-manifest.json) – keine anderen URLs.
 * - Teil-Downloads werden fortgesetzt (HTTP-Range), erst nach Größen- UND Hash-Prüfung wird installiert.
 * - Entpackt wird nur, was das Manifest nennt, flach in den Zielordner (kein Pfad aus dem Archiv) -> kein Zip-Slip.
 * - Nichts außerhalb von `tools/`; Deinstallation = Ordner löschen.
 */
export interface ManifestItem {
  id: string;
  label: string;
  url: string;
  sha256: string;
  size: number;
  type: 'zip' | 'file';
  /** Zielordner (zip) bzw. Zieldatei (file), relativ zu tools/ */
  target: string;
  /** zip: zu übernehmende Einträge (Pfad-Suffix wie "bin/ffmpeg.exe" oder Muster "*.dll") */
  files?: string[];
  /** Datei, deren Existenz "installiert" bedeutet (relativ zu tools/) */
  check: string;
}

export interface Manifest {
  version: 1;
  platform: string;
  items: ManifestItem[];
}

const SAFE_REL = /^(?!.*\.\.)(?![\\/])[\w.\-/]{1,200}$/;

export function validateManifest(raw: unknown, opts: { allowLocalHttp?: boolean } = {}): Manifest {
  const m = raw as Manifest;
  if (!m || m.version !== 1 || typeof m.platform !== 'string' || !Array.isArray(m.items)) throw codedError('Manifest ungültig', 'download_manifest');
  const ids = new Set<string>();
  for (const it of m.items) {
    const okUrl = (() => {
      try {
        const u = new URL(it.url);
        return u.protocol === 'https:' || (!!opts.allowLocalHttp && u.protocol === 'http:' && u.hostname === '127.0.0.1');
      } catch {
        return false;
      }
    })();
    if (
      !/^[a-z0-9][a-z0-9._-]{0,40}$/.test(it.id) ||
      ids.has(it.id) ||
      typeof it.label !== 'string' ||
      !okUrl ||
      !/^[a-f0-9]{64}$/.test(it.sha256) ||
      !Number.isInteger(it.size) ||
      it.size <= 0 ||
      !['zip', 'file'].includes(it.type) ||
      !SAFE_REL.test(it.target) ||
      !SAFE_REL.test(it.check) ||
      (it.files !== undefined && (!Array.isArray(it.files) || !it.files.every((f) => typeof f === 'string' && SAFE_REL.test(f.replace(/\*/g, 'x')))))
    ) {
      throw codedError(`Manifest-Eintrag ungültig: ${String(it.id)}`, 'download_manifest');
    }
    ids.add(it.id);
  }
  return m;
}

export function loadManifest(file: string, opts: { allowLocalHttp?: boolean } = {}): Manifest {
  return validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')), opts);
}

export function currentPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

export function isInstalled(toolsDir: string, item: ManifestItem): boolean {
  return fs.existsSync(path.join(toolsDir, item.check));
}

/** Eintrag aus dem Archiv übernehmen? Muster mit "/" = Pfad-Suffix, sonst Dateiname mit "*". */
export function matchesPattern(entryName: string, patterns: string[]): boolean {
  const name = entryName.replace(/\\/g, '/');
  const base = name.split('/').pop() ?? '';
  return patterns.some((p) => {
    if (p.includes('/')) return name === p || name.endsWith('/' + p);
    const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(base);
  });
}

function networkError(err: unknown): Error {
  const e = err as { name?: string; cause?: { code?: string }; code?: string; message?: string };
  if (e.name === 'AbortError' || e.code === 'download_cancelled') return codedError('Download abgebrochen', 'download_cancelled');
  return codedError(`Download fehlgeschlagen: ${e.cause?.code ?? e.message ?? 'Netzwerkfehler'}`, 'download_network', err);
}

async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

/** Download mit Fortsetzung; gibt den Pfad der vollständigen, geprüften Datei zurück. */
export async function download(
  item: ManifestItem,
  toolsDir: string,
  opts: { signal?: AbortSignal; onProgress?: (received: number, total: number) => void } = {},
): Promise<string> {
  const dir = path.join(toolsDir, '.download');
  await fsp.mkdir(dir, { recursive: true });
  const part = path.join(dir, `${item.id}.part`);
  let have = 0;
  try {
    have = (await fsp.stat(part)).size;
  } catch {
    /* neu */
  }
  if (have > item.size) {
    await fsp.rm(part, { force: true });
    have = 0;
  }
  if (have < item.size) {
    let res: Response;
    try {
      res = await fetch(item.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal: opts.signal, redirect: 'follow' });
    } catch (err) {
      throw networkError(err);
    }
    if (res.status === 407) throw codedError('Proxy verlangt Anmeldung', 'download_proxy');
    if (res.status === 416 && have) {
      // Server hat nichts mehr zu liefern -> unten prüfen
    } else if (!res.ok || !res.body) {
      throw codedError(`Download fehlgeschlagen: HTTP ${res.status}`, 'download_http');
    } else {
      const append = res.status === 206 && have > 0;
      if (!append) have = 0;
      let received = have;
      const meter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          received += chunk.byteLength;
          if (received > item.size) {
            ctrl.error(codedError('Datei größer als im Manifest angegeben', 'download_size_mismatch'));
            return;
          }
          opts.onProgress?.(received, item.size);
          ctrl.enqueue(chunk);
        },
      });
      try {
        await pipeline(Readable.fromWeb(res.body.pipeThrough(meter) as never), fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
      } catch (err) {
        if ((err as { code?: string }).code === 'download_size_mismatch') {
          await fsp.rm(part, { force: true });
          throw err;
        }
        throw networkError(err); // Teil-Download bleibt liegen -> nächster Versuch setzt fort
      }
    }
  }
  const size = (await fsp.stat(part)).size;
  if (size !== item.size) throw codedError(`Größe stimmt nicht (${size} statt ${item.size})`, size > item.size ? 'download_size_mismatch' : 'download_network');
  const hash = await sha256File(part);
  if (hash !== item.sha256) {
    await fsp.rm(part, { force: true });
    throw codedError('SHA-256 stimmt nicht – Datei verworfen', 'download_hash_mismatch');
  }
  return part;
}

/** Geprüfte Datei installieren (atomar per Umbenennen eines Staging-Ordners). */
export async function install(item: ManifestItem, toolsDir: string, file: string): Promise<void> {
  const target = path.join(toolsDir, item.target);
  if (!path.resolve(target).startsWith(path.resolve(toolsDir) + path.sep)) throw codedError('Ziel außerhalb von tools/', 'download_manifest');
  if (item.type === 'file') {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { force: true });
    await fsp.rename(file, target);
  } else {
    const staging = path.join(toolsDir, '.download', `${item.id}.staging`);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    const zip = await openZip(file, { maxEntries: 20_000, maxTotalBytes: 4 * 1024 ** 3, maxEntryBytes: 2 * 1024 ** 3, maxRatio: 1000 });
    let n = 0;
    try {
      for (const e of zip.entries) {
        if (e.isDir || e.isSymlink || e.encrypted || !matchesPattern(e.name, item.files ?? ['*'])) continue;
        const base = path.basename(e.name.replace(/\\/g, '/'));
        if (!/^[\w.\- ]{1,120}$/.test(base)) continue;
        await pipeline(await zip.openStream(e, 2 * 1024 ** 3), fs.createWriteStream(path.join(staging, base)));
        n++;
      }
    } finally {
      zip.close();
    }
    if (!n) throw codedError('Archiv enthält die erwarteten Dateien nicht', 'download_contents');
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(staging, target);
    await fsp.rm(file, { force: true });
  }
  if (!isInstalled(toolsDir, item)) throw codedError('Nach der Installation fehlt die erwartete Datei', 'download_contents');
}
