// Prüft, ob node_modules zu package-lock.json passt (Marker = SHA-256 der Lock-Datei).
//   node scripts/check-deps.mjs [projektordner]          -> Exit 0: aktuell, Exit 1: `npm ci` nötig
//   node scripts/check-deps.mjs --write [projektordner]  -> Marker nach erfolgreicher Installation schreiben
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? ROOT);
const lockFile = path.join(dir, 'package-lock.json');
const marker = path.join(dir, 'node_modules', '.hotspot-lock-hash');

const hash = crypto.createHash('sha256').update(fs.readFileSync(lockFile)).digest('hex');
if (write) {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, hash);
  process.exit(0);
}
let current = '';
try {
  current = fs.readFileSync(marker, 'utf8').trim();
} catch {
  /* noch nie installiert */
}
process.exit(current === hash ? 0 : 1);
