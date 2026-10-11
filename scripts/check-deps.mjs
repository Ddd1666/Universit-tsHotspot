// Prüft, ob node_modules zu package-lock.json passt (Marker = SHA-256 der Lock-Datei).
//   node scripts/check-deps.mjs [projektordner]          -> Exit 0: aktuell, Exit 1: `npm ci` nötig
//   node scripts/check-deps.mjs --write [projektordner]  -> Marker nach erfolgreicher Installation schreiben
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const markerFile = (dir) => path.join(dir, 'node_modules', '.hotspot-lock-hash');
const lockHash = (dir) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex');

export function depsUpToDate(dir = ROOT) {
  try {
    return fs.readFileSync(markerFile(dir), 'utf8').trim() === lockHash(dir);
  } catch {
    return false; // noch nie installiert
  }
}

export function writeDepsMarker(dir = ROOT) {
  fs.mkdirSync(path.dirname(markerFile(dir)), { recursive: true });
  fs.writeFileSync(markerFile(dir), lockHash(dir));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? ROOT);
  if (args.includes('--write')) {
    writeDepsMarker(dir);
    process.exit(0);
  }
  process.exit(depsUpToDate(dir) ? 0 : 1);
}
