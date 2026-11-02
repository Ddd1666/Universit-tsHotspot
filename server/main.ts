import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { createHotspot, installProcessGuards, type Hotspot } from './app.ts';
import { AlreadyRunningError } from './lock.ts';

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    /* Browser öffnen ist optional */
  }
}

/** CLI-Start im Browser-Modus: `node server/main.ts [--open]` */
async function main(): Promise<void> {
  const config = loadConfig();
  const open = process.argv.includes('--open');
  console.log(`Uni-Hotspot startet … Datenordner: ${config.dataDir}`);
  if (config.mockOllama) console.log('⚠  MOCK-MODUS: Antworten/Embeddings kommen vom Test-Mock, nicht von Ollama (HOTSPOT_MOCK_OLLAMA=1).');
  if (!config.webDir) console.log('Hinweis: Web-UI ist nicht gebaut (npm run build). Nur API verfügbar.');

  // Signale von Anfang an abfangen (nicht erst nach listen/Ollama-Check): sonst beendet ein frühes
  // Strg+C den Prozess hart, ohne DB zu schließen und die Sperrdatei zu entfernen.
  let hotspot: Hotspot | undefined;
  let stopping = false;
  let restarting: Promise<void> | null = null;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Beende …');
    if (restarting) await restarting.catch(() => {});
    if (!hotspot) return; // Start läuft noch -> wird direkt danach geschlossen
    await hotspot.close();
    process.exit(0);
  };
  // Wiederherstellung: Server im selben Prozess neu starten (gleicher Port und Token -> die Oberfläche lädt nur neu)
  config.requestRestart = () => {
    if (stopping || restarting || !hotspot) return;
    restarting = (async () => {
      console.log('Neustart (Wiederherstellung) …');
      await hotspot!.close();
      hotspot = undefined;
      hotspot = await createHotspot(config);
      await hotspot.listen();
      console.log('Neu gestartet.');
    })()
      .catch((err: Error) => {
        console.error('Neustart fehlgeschlagen:', err.message);
        process.exit(1);
      })
      .finally(() => (restarting = null));
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  installProcessGuards({
    log: (msg, extra) => (hotspot ? hotspot.app.log.error({ extra }, msg) : console.error(msg, extra)),
    fatal: async () => {
      console.error('Schwerer interner Fehler – Uni-Hotspot wird beendet (Details im Log).');
      const h = hotspot;
      hotspot = undefined;
      await (h ? h.close() : Promise.resolve()).catch(() => {});
      process.exit(1);
    }, // hängt close(), beendet das Zeitlimit des Wächters (8 s) den Prozess
  });

  try {
    hotspot = await createHotspot(config);
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      // Zweiter Start: laufende Instanz unangetastet lassen, nur darauf hinweisen
      const url = err.port ? `http://127.0.0.1:${err.port}` : null;
      console.log(`\n  Uni-Hotspot läuft bereits${url ? ` auf ${url}` : ''} (gleicher Datenordner) – kein zweiter Start nötig.`);
      console.log(`  Falls sicher keine Instanz läuft: Sperrdatei löschen und neu starten:\n    ${err.lockFile}\n`);
      if (url && open) openBrowser(url);
      process.exit(0);
    }
    console.error('Start fehlgeschlagen:', (err as Error).message);
    process.exit(1);
  }
  if (stopping) {
    await hotspot.close();
    process.exit(0);
  }

  let url: string;
  try {
    ({ url } = await hotspot.listen());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`\n  Port ${config.port} ist belegt (anderes Programm). Anderen Port wählen, z. B.:\n    cmd:        set HOTSPOT_PORT=4318\n    PowerShell: $env:HOTSPOT_PORT="4318"\n`);
    } else console.error('Server-Start fehlgeschlagen:', (err as Error).message);
    await hotspot.close();
    process.exit(1);
  }
  console.log(`\n  Uni-Hotspot läuft:  ${url}\n  (Beenden mit Strg+C)\n`);
  if (hotspot.services.lastRestore) console.log(hotspot.services.lastRestore.ok ? `  Wiederherstellung ausgeführt: ${hotspot.services.lastRestore.id}` : '  Vorgemerkte Wiederherstellung war ungültig und wurde verworfen.');
  const status = await hotspot.services.monitor.refresh();
  if (!status.reachable) {
    console.log('  Ollama nicht erreichbar – Volltextsuche & Import funktionieren, KI-Funktionen erst nach Start von Ollama.');
  }

  if (open) openBrowser(url);
}

void main();
