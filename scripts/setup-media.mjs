// Medien-Werkzeuge (whisper.cpp, ffmpeg, Whisper-Modell) in <Projektordner>/tools laden – ohne Admin, reversibel.
//   node scripts/setup-media.mjs --status                 Status anzeigen (lädt nichts)
//   node scripts/setup-media.mjs                          Standard-Paket (whisper, ffmpeg, model-small) nach Rückfrage
//   node scripts/setup-media.mjs whisper model-medium-q5_0  bestimmte Einträge
//   --yes                                                 ohne Rückfrage (nur wenn der Nutzer bereits zugestimmt hat)
// Quellen, SHA-256 und Größen stehen in scripts/media-manifest.json. Proxy: HTTPS_PROXY setzen und NODE_USE_ENV_PROXY=1.
import path from 'node:path';
import readline from 'node:readline/promises';
import { ROOT } from './lib.mjs';

const { loadManifest, download, install, isInstalled, currentPlatform } = await import('../server/media/installer.ts');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const toolsDir = process.env.HOTSPOT_TOOLS_DIR ? path.resolve(process.env.HOTSPOT_TOOLS_DIR) : path.join(ROOT, 'tools');
const manifestFile = process.env.HOTSPOT_MEDIA_MANIFEST ? path.resolve(process.env.HOTSPOT_MEDIA_MANIFEST) : path.join(ROOT, 'scripts', 'media-manifest.json');
const manifest = loadManifest(manifestFile, { allowLocalHttp: process.env.HOTSPOT_MEDIA_ALLOW_LOCAL_HTTP === '1' });
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

const HINTS = {
  download_network: 'Netzwerkfehler. Internet/Proxy prüfen (Proxy: HTTPS_PROXY=… und NODE_USE_ENV_PROXY=1). Erneuter Start setzt den Download fort.',
  download_proxy: 'Der Proxy verlangt eine Anmeldung (HTTP 407).',
  download_http: 'Der Server hat den Download abgelehnt.',
  download_hash_mismatch: 'SHA-256 stimmt nicht – Datei wurde verworfen (beschädigt oder verändert). Nichts installiert.',
  download_size_mismatch: 'Dateigröße stimmt nicht mit dem Manifest überein – nichts installiert.',
  download_contents: 'Archiv enthält die erwarteten Dateien nicht.',
  download_cancelled: 'Abgebrochen.',
};

console.log(`Ziel: ${toolsDir}  (Plattform ${currentPlatform()}, Manifest für ${manifest.platform})`);
for (const it of manifest.items) console.log(`  ${isInstalled(toolsDir, it) ? '[x]' : '[ ]'} ${it.id.padEnd(18)} ${mb(it.size).padStart(9)}  ${it.label}`);
if (flags.has('--status')) process.exit(0);

if (manifest.platform !== currentPlatform()) {
  console.error(`\nAutomatische Installation nur unter ${manifest.platform}. Werkzeuge ggf. manuell nach ${toolsDir} legen (siehe README).`);
  process.exit(1);
}
const ids = args.filter((a) => !a.startsWith('--'));
const wanted = (ids.length ? ids : ['whisper', 'ffmpeg', 'model-small']).map((id) => {
  const it = manifest.items.find((x) => x.id === id);
  if (!it) {
    console.error(`Unbekannter Eintrag: ${id}`);
    process.exit(1);
  }
  return it;
});
const todo = wanted.filter((it) => !isInstalled(toolsDir, it));
if (!todo.length) {
  console.log('\nAlles bereits installiert.');
  process.exit(0);
}
const total = todo.reduce((n, it) => n + it.size, 0);
console.log(`\nZu laden: ${todo.map((it) => it.id).join(', ')} – zusammen ${mb(total)}`);
for (const it of todo) console.log(`  ${it.url}`);
if (!flags.has('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Herunterladen und nach tools/ installieren? (j/N) ')).trim().toLowerCase();
  rl.close();
  if (!['j', 'ja', 'y', 'yes'].includes(answer)) {
    console.log('Nichts geladen.');
    process.exit(0);
  }
}
const ctrl = new AbortController();
process.on('SIGINT', () => ctrl.abort());
for (const it of todo) {
  let last = -1;
  try {
    const file = await download(it, toolsDir, {
      signal: ctrl.signal,
      onProgress: (r, t) => {
        const p = Math.floor((r / t) * 100);
        if (p !== last && p % 5 === 0) process.stdout.write(`\r  ${it.id}: ${p} %   `);
        last = p;
      },
    });
    process.stdout.write(`\r  ${it.id}: SHA-256 ok, installiere …   `);
    await install(it, toolsDir, file);
    console.log(`\r  ${it.id}: installiert                 `);
  } catch (err) {
    console.error(`\n  ${it.id}: FEHLER (${err.code ?? 'unbekannt'}) – ${HINTS[err.code] ?? err.message}`);
    process.exit(1);
  }
}
console.log('\nFertig. Uni-Hotspot erkennt die Werkzeuge automatisch (Einstellungen → Medien).');
