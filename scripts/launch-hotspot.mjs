// Desktop-Icon (Windows): Uni-Hotspot in Chrome öffnen, den Server vorher starten, falls er nicht läuft.
// Aufruf über scripts/launch-hotspot.cmd (Ziel der Verknüpfung, prüft vorher Node).
//
//  1. Läuft Uni-Hotspot (GET /api/health ohne Token -> 401 invalid_token)? Geprüft werden der Port aus der
//     Instanz-Sperre (<Datenordner>/hotspot.lock, z. B. Desktop-App mit freiem Port) und HOTSPOT_PORT (wie loadConfig).
//  2. Nein und Port frei: `start.bat server` in einem minimierten Fenster (Erststart inkl. npm ci/Build), warten.
//     Antwortet dort etwas anderes: Meldung, kein Browser.
//  3. Chrome als App-Fenster (--app=URL), ohne Chrome der Standardbrowser.
// Fehler: MessageBox (das Launcher-Fenster ist minimiert, eine Konsolenmeldung sähe niemand) + Exit-Code 1.
//
// Umgebungsvariablen (Überschreiben/Tests):
//   HOTSPOT_PORT            wie beim Server (Standard 4317; 0 = freier Port -> nur über die Sperre auffindbar)
//   HOTSPOT_CHROME          Pfad zu chrome.exe statt der Suche; "none" = so tun, als fehle Chrome
//   HOTSPOT_OPEN_URL_WITH   Programm statt des Standardbrowsers (Tests)
//   HOTSPOT_START_SCRIPT    Start-Skript statt start.bat (Tests; bekommt das Argument "server")
//   HOTSPOT_LAUNCH_TIMEOUT  Wartezeit auf den Server in Sekunden (Standard 180)
//   HOTSPOT_LAUNCH_NO_DIALOG=1  keine MessageBox, nur Konsole (Tests)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';
import { resolveDataDir } from '../server/config.ts';

const dataDir = resolveDataDir();
const envPort = Number(process.env.HOTSPOT_PORT);
// gleiche Regel wie loadConfig() in server/config.ts: ungültig -> 4317, 0 -> freier Port (nur über die Sperre)
const configuredPort = Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : 4317;
const timeoutMs = (Number(process.env.HOTSPOT_LAUNCH_TIMEOUT) || 180) * 1000;
const logFile = path.join(dataDir, 'logs', 'server.log');
const url = (port) => `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\n${message}\n`);
  if (process.env.HOTSPOT_LAUNCH_NO_DIALOG !== '1') {
    // Text über die Umgebung übergeben: kein Quoting-Problem mit Pfaden/Anführungszeichen
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).Popup($env:HOTSPOT_LAUNCH_MSG, 0, 'Uni-Hotspot', 48) | Out-Null"], {
      env: { ...process.env, HOTSPOT_LAUNCH_MSG: message },
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  process.exit(1);
}

/** 'hotspot' | 'free' (nichts lauscht) | Beschreibung dessen, was sonst antwortet */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (body.length < 4096) body += d;
      });
      res.on('end', () => resolve(res.statusCode === 401 && body.includes('invalid_token') ? 'hotspot' : `HTTP ${res.statusCode}`));
      res.on('error', () => resolve('abgebrochene Antwort'));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('keine Antwort');
    });
    req.on('error', (err) => resolve(err.code === 'ECONNREFUSED' ? 'free' : `Fehler ${err.code ?? err.message}`));
  });
}

function lockPort() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'hotspot.lock'), 'utf8')).port;
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}

/** { port } wenn Uni-Hotspot antwortet, sonst { state } des konfigurierten Ports */
async function find() {
  const lp = lockPort();
  if (lp && lp !== configuredPort && (await probe(lp)) === 'hotspot') return { port: lp };
  if (!configuredPort) return { state: 'free' };
  const state = await probe(configuredPort);
  return state === 'hotspot' ? { port: configuredPort } : { state };
}

const foreign = (state) =>
  `Auf Port ${configuredPort} antwortet ein anderes Programm (${state}), nicht Uni-Hotspot.\n` +
  'Uni-Hotspot wird deshalb nicht geöffnet.\n\n' +
  'Das andere Programm beenden oder Uni-Hotspot auf einem anderen Port betreiben (Umgebungsvariable HOTSPOT_PORT, siehe README, Abschnitt „Desktop-Icon“).';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Nur ein Launcher startet den Server (Doppelklick-Serie): exklusive Datei im Datenordner mit der eigenen PID.
 * Hält ein lebender Launcher sie (und ist sie nicht älter als seine Wartezeit), startet dieser hier nichts.
 */
function claimStart() {
  const file = path.join(dataDir, 'launcher.lock');
  fs.mkdirSync(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      process.once('exit', () => {
        try {
          if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          /* schon weg */
        }
      });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let pid = 0;
    let age = Infinity;
    try {
      pid = Number(fs.readFileSync(file, 'utf8'));
      age = Date.now() - fs.statSync(file).mtimeMs;
    } catch {
      /* gerade entfernt -> erneut versuchen */
    }
    if (pid && isAlive(pid) && age < timeoutMs + 60_000) return false;
    fs.rmSync(file, { force: true }); // verwaist (Launcher abgestürzt / PID wiederverwendet)
  }
  return false;
}

function startServer() {
  const script = process.env.HOTSPOT_START_SCRIPT || path.join(ROOT, 'start.bat');
  console.log('Starte Uni-Hotspot … (beim ersten Start bis zu 3 Minuten: Installation und Aufbau der Oberfläche)');
  // eigenes, minimiertes Fenster: bleibt als Server offen (schließen = beenden), zeigt Fehler (start.bat pausiert dann)
  spawn(`start "Uni-Hotspot" /min cmd /c ""${script}" server"`, { shell: true, stdio: 'ignore', windowsHide: true });
}

function findChrome() {
  const override = process.env.HOTSPOT_CHROME;
  if (override) return override !== 'none' && fs.existsSync(override) ? override : null;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    if (!base) continue;
    const exe = path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function openBrowser(target) {
  const chrome = findChrome();
  const opener = process.env.HOTSPOT_OPEN_URL_WITH;
  const cmd = chrome ? `start "" /b "${chrome}" --app=${target}` : opener ? `start "" /b "${opener}" ${target}` : `start "" "${target}"`;
  console.log(chrome ? `Öffne Chrome: ${target}` : `Chrome nicht gefunden – öffne den Standardbrowser: ${target}`);
  spawnSync(cmd, { shell: true, stdio: 'ignore', windowsHide: true });
}

let found = await find();
if (!found.port) {
  if (found.state !== 'free') fail(foreign(found.state));
  if (!claimStart()) {
    console.log('Uni-Hotspot wird gerade schon gestartet (anderer Klick) – Chrome öffnet sich gleich.');
    process.exit(0);
  }
  startServer();
  const end = Date.now() + timeoutMs;
  while (!found.port) {
    await sleep(1000);
    found = await find();
    if (found.state && found.state !== 'free') fail(foreign(found.state));
    if (!found.port && Date.now() > end) {
      fail(
        `Uni-Hotspot antwortet nach ${Math.round(timeoutMs / 1000)} Sekunden nicht${configuredPort ? ` auf ${url(configuredPort)}` : ''}.\n\n` +
          'Bitte das minimierte Fenster „Uni-Hotspot“ (Server) in der Taskleiste öffnen und die Meldung dort lesen.\n' +
          `Protokoll: ${logFile}\n\n` +
          'Zum Vergleich: start-browser.bat doppelklicken.',
      );
    }
  }
}
openBrowser(url(found.port));
