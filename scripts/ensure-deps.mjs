// Abhängigkeiten vor dem Start aktuell halten (aufgerufen von start.bat / start.sh):
//   - node_modules passt zu package-lock.json (Hash-Marker)  -> nichts tun
//   - sonst Registry prüfen (npm ping); erreichbar           -> npm ci, danach Marker schreiben
//   - KEIN Internet: npm ci würde node_modules zuerst löschen -> nicht ausführen. Ist eine lauffähige
//     Installation vorhanden, mit dem bisherigen Stand starten; sonst mit klarer Meldung abbrechen.
// Exit 0: weiter starten, Exit 1: abbrechen.   node scripts/ensure-deps.mjs [projektordner]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';
import { depsUpToDate, writeDepsMarker } from './check-deps.mjs';

const dir = path.resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? ROOT);

function npm(args, opts = {}) {
  // Nur für Tests: npm durch ein Node-Skript ersetzen
  if (process.env.HOTSPOT_NPM_SCRIPT) return spawnSync(process.execPath, [process.env.HOTSPOT_NPM_SCRIPT, ...args], { cwd: dir, ...opts });
  const win = process.platform === 'win32';
  return spawnSync(win ? 'npm.cmd' : 'npm', args, { cwd: dir, shell: win, ...opts });
}

if (depsUpToDate(dir)) process.exit(0);

const installed = fs.existsSync(path.join(dir, 'node_modules', 'fastify', 'package.json'));
const ping = npm(['ping', '--fetch-timeout=10000', '--fetch-retries=0'], { stdio: 'ignore' });
if (ping.status !== 0) {
  if (installed) {
    console.log('\n  Update braucht Internet: die Abhängigkeiten wurden geändert, die npm-Registry ist aber nicht erreichbar.');
    console.log('  Uni-Hotspot startet mit dem bisherigen Stand (nichts gelöscht). Für das Update später mit Internet erneut starten.\n');
    process.exit(0);
  }
  console.log('\n  Die Erstinstallation braucht Internet (npm-Registry nicht erreichbar).');
  console.log('  Bitte mit Internetverbindung erneut starten.\n');
  process.exit(1);
}

console.log('\n  Abhängigkeiten werden installiert/aktualisiert (ca. 1–3 Minuten) …\n');
const ci = npm(['ci', '--no-audit', '--no-fund'], { stdio: 'inherit' });
if (ci.status !== 0) {
  console.log('\n  npm ci ist fehlgeschlagen – Details siehe oben. Mit stabiler Internetverbindung erneut starten.\n');
  process.exit(1);
}
writeDepsMarker(dir);
process.exit(0);
