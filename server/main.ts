import { spawn } from 'node:child_process';
import { loadConfig } from './config.ts';
import { createHotspot } from './app.ts';

/** CLI-Start im Browser-Modus: `node server/main.ts [--open]` */
async function main(): Promise<void> {
  const config = loadConfig();
  const open = process.argv.includes('--open');
  console.log(`Uni-Hotspot startet … Datenordner: ${config.dataDir}`);
  if (config.mockOllama) console.log('⚠  MOCK-MODUS: Antworten/Embeddings kommen vom Test-Mock, nicht von Ollama (HOTSPOT_MOCK_OLLAMA=1).');
  if (!config.webDir) console.log('Hinweis: Web-UI ist nicht gebaut (npm run build). Nur API verfügbar.');

  let hotspot;
  try {
    hotspot = await createHotspot(config);
  } catch (err) {
    console.error('Start fehlgeschlagen:', (err as Error).message);
    process.exit(1);
  }
  let url: string;
  try {
    ({ url } = await hotspot.listen());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      console.error(`Port ${config.port} ist belegt. Läuft Uni-Hotspot bereits? Sonst anderen Port wählen: HOTSPOT_PORT=4318`);
    } else console.error('Server-Start fehlgeschlagen:', (err as Error).message);
    await hotspot.close();
    process.exit(1);
  }
  console.log(`\n  Uni-Hotspot läuft:  ${url}\n  (Beenden mit Strg+C)\n`);
  const status = await hotspot.services.monitor.refresh();
  if (!status.reachable) {
    console.log('  Ollama nicht erreichbar – Volltextsuche & Import funktionieren, KI-Funktionen erst nach Start von Ollama.');
  }

  if (open) {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    } catch {
      /* Browser öffnen ist optional */
    }
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Beende …');
    await hotspot.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
