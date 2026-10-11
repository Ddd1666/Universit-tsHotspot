// Entwicklungsmodus: Backend (node --watch) + Vite-Dev-Server mit HMR.
// Öffnen: http://127.0.0.1:5173  (API wird auf 127.0.0.1:4317 weitergeleitet)
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkNode, NODE_FLAGS, ROOT } from './lib.mjs';

checkNode();
const token = crypto.randomBytes(32).toString('hex');
const apiPort = process.env.HOTSPOT_PORT ?? '4317';
const env = { ...process.env, HOTSPOT_TOKEN: token, HOTSPOT_PORT: apiPort, HOTSPOT_API_PORT: apiPort, HOTSPOT_DEV_ORIGIN: 'http://127.0.0.1:5173' };

const children = [
  spawn(process.execPath, [...NODE_FLAGS, '--watch-path=server', path.join(ROOT, 'server', 'main.ts')], { cwd: ROOT, stdio: 'inherit', env }),
  spawn(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: ROOT, stdio: 'inherit', env }),
];
console.log('\n  Dev-Modus: http://127.0.0.1:5173  (Strg+C beendet beide Prozesse)\n');

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && stop());
