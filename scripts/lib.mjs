// Gemeinsame Hilfen für Start-/Dev-Skripte (reines JS, läuft ohne Build).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

/** Node >= 22.18 (eingebautes SQLite + TypeScript-Ausführung ohne Build). */
export function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 18)) {
    console.error(
      `\n  Node.js ${process.versions.node} ist zu alt. Benötigt: 22.18 oder neuer (empfohlen: 24 LTS).\n` +
        '  Download (ohne Admin möglich, "Windows Binary (.zip)"): https://nodejs.org/en/download\n',
    );
    process.exit(1);
  }
}

function newestMtime(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of fs.readdirSync(p)) max = Math.max(max, newestMtime(path.join(p, e)));
  return max;
}

/** Web-UI nur neu bauen, wenn Quellen neuer sind als der Build. */
export function ensureWebBuild({ force = false } = {}) {
  const index = path.join(ROOT, 'dist', 'web', 'index.html');
  const built = fs.existsSync(index) ? fs.statSync(index).mtimeMs : 0;
  const src = Math.max(newestMtime(path.join(ROOT, 'web')), newestMtime(path.join(ROOT, 'vite.config.ts')), newestMtime(path.join(ROOT, 'package-lock.json')));
  if (!force && built > src) return;
  console.log('Baue Web-Oberfläche …');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('Build der Web-Oberfläche fehlgeschlagen.');
    process.exit(1);
  }
}

/** Downloads/Caches von npm/Electron im Projektordner halten (nichts außerhalb schreiben). */
export function localCacheEnv() {
  return {
    npm_config_cache: path.join(ROOT, '.cache', 'npm'),
    electron_config_cache: path.join(ROOT, '.cache', 'electron'),
  };
}
