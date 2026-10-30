// Portables Windows-Paket (ohne Installer, ohne Admin): Electron-Laufzeit + App ohne Dev-Abhängigkeiten.
//   node scripts/package-win.mjs [--electron-dist <ordner>] [--out <ordner>] [--check]
// Voraussetzungen: `npm ci`, `npm run build` (dist/web), Electron-Laufzeit für Windows unter node_modules/electron/dist
// (`node node_modules/electron/install.js` auf einem Windows-Rechner bzw. im CI-Lauf auf windows-latest).
// --check: nur die App-Dateien zusammenstellen und prüfen (ohne Electron-Laufzeit; läuft auf jedem System).
//
// Warum kein electron-builder: ~200 MB zusätzliche Dev-Abhängigkeiten (app-builder-bin für alle Plattformen, NSIS-Download
// beim Bauen) für etwas, das hier ein Kopierschritt ist: keine nativen Module, kein Code-Signing, kein Auto-Updater.
// Ergebnis: out/Uni-Hotspot-<version>-win-x64/Uni-Hotspot.exe (+ LIESMICH.txt); als ZIP liefert es der CI-Artefakt-Download.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const check = process.argv.includes('--check');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const electronDist = path.resolve(arg('--electron-dist') ?? path.join(ROOT, 'node_modules', 'electron', 'dist'));
const outRoot = path.resolve(arg('--out') ?? path.join(ROOT, 'out'));
const name = `Uni-Hotspot-${pkg.version}-win-x64`;
const out = path.join(outRoot, name);
const appDir = check ? path.join(outRoot, `${name}-app`) : path.join(out, 'resources', 'app');

const fail = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};
if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) fail('dist/web fehlt – zuerst "npm run build".');
if (!check && !fs.existsSync(path.join(electronDist, 'electron.exe'))) fail(`Electron-Laufzeit für Windows fehlt (${electronDist}\\electron.exe) – "node node_modules/electron/install.js" auf Windows ausführen.`);

fs.rmSync(check ? appDir : out, { recursive: true, force: true });
if (!check) {
  // 1) Electron-Laufzeit, umbenannt; die Standard-App von Electron fliegt raus
  fs.cpSync(electronDist, out, { recursive: true });
  fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'Uni-Hotspot.exe'));
  fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
}

// 2) App-Dateien (kein asar: TypeScript läuft per Type-Stripping direkt aus dem Ordner)
const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(appDir, rel), { recursive: true });
for (const rel of ['electron', 'server', path.join('dist', 'web'), path.join('scripts', 'media-manifest.json')]) copy(rel);
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', main: pkg.main, description: pkg.description }, null, 2) + '\n',
);

// 3) Laufzeit-Abhängigkeiten laut package-lock (ohne dev/devOptional); verschachtelte node_modules einzeln
let packages = 0;
for (const [key, meta] of Object.entries(lock.packages)) {
  if (!key.startsWith('node_modules/') || meta.dev || meta.devOptional || meta.link) continue;
  const src = path.join(ROOT, key);
  if (!fs.existsSync(src)) {
    if (meta.optional) continue; // optionale Plattform-Pakete anderer Systeme
    fail(`Abhängigkeit fehlt: ${key} – "npm ci" ausführen.`);
  }
  fs.cpSync(src, path.join(appDir, key), { recursive: true, filter: (p) => p === src || !p.slice(src.length).split(path.sep).includes('node_modules') });
  packages++;
}

// 4) Kurzanleitung im Paket
fs.writeFileSync(
  path.join(check ? appDir : out, 'LIESMICH.txt'),
  [
    `Uni-Hotspot ${pkg.version} – portable Windows-Version (ohne Installation, ohne Admin-Rechte)`,
    '',
    '1. Den ganzen Ordner an einen festen Ort legen, z. B. %USERPROFILE%\\Uni-Hotspot (nicht in OneDrive/Downloads).',
    '2. Uni-Hotspot.exe doppelklicken. Windows SmartScreen warnt, weil das Programm nicht signiert ist:',
    '   "Weitere Informationen" -> "Trotzdem ausführen". Nichts wird installiert, keine Registry, kein Autostart.',
    '3. Ollama muss laufen (https://ollama.com). Modelle lädt die App nie selbst – der Einrichtungsassistent zeigt die Befehle.',
    '',
    'Daten: %USERPROFILE%\\Uni-Hotspot-Daten (Datenbank, Originaldateien, Sicherungen, Logs). Der Programmordner enthält keine Nutzerdaten.',
    'Update: neue Version über diesen Ordner entpacken (oder neuen Ordner nutzen). Der Datenordner bleibt unberührt;',
    'eine nötige Datenbank-Migration legt vorher automatisch eine Sicherung unter <Datenordner>\\backups an.',
    'Entfernen: diesen Ordner löschen (Daten bleiben, bis du den Datenordner selbst löschst).',
    'Medien-Werkzeuge (whisper.cpp, ffmpeg) sind nicht enthalten – Download nach Bestätigung unter Einstellungen -> Medien',
    '(landen in resources\\app\\tools).',
    '',
  ].join('\r\n'),
);

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
// Plausibilität: Einstieg, Oberfläche, jede Laufzeit-Abhängigkeit auflösbar
for (const f of [pkg.main, 'server/app.ts', 'dist/web/index.html', 'scripts/media-manifest.json']) if (!fs.existsSync(path.join(appDir, f))) fail(`Paket unvollständig: ${f}`);
for (const dep of Object.keys(pkg.dependencies)) if (!fs.existsSync(path.join(appDir, 'node_modules', dep, 'package.json'))) fail(`Paket unvollständig: node_modules/${dep}`);
console.log(`${check ? 'App-Dateien' : 'Paket'}: ${check ? appDir : out}`);
console.log(`  ${packages} Laufzeit-Pakete, App ${(size(appDir) / 1024 / 1024).toFixed(1)} MB${check ? '' : `, gesamt ${(size(out) / 1024 / 1024).toFixed(0)} MB`}`);
