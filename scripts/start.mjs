// Start: `node scripts/start.mjs [--desktop|--browser] [--open]`
//  --desktop  Electron-Fenster (Standard bei start.bat); fällt auf Browser-Modus zurück, falls Electron fehlt
//  --browser  nur lokaler Server -> http://127.0.0.1:4317 (Standard bei `npm start`)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { checkNode, ensureWebBuild, localCacheEnv, NODE_FLAGS, ROOT } from './lib.mjs';

checkNode();
const args = process.argv.slice(2);
const desktop = args.includes('--desktop');
const open = args.includes('--open');

if (!fs.existsSync(path.join(ROOT, 'node_modules', 'fastify'))) {
  console.error('Abhängigkeiten fehlen. Bitte zuerst "npm install" ausführen (oder start.bat verwenden).');
  process.exit(1);
}
ensureWebBuild();

function runBrowser() {
  const child = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'server', 'main.ts'), ...(open ? ['--open'] : [])], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  const forward = (sig) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}

function runDesktop() {
  const cli = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.warn('Electron ist nicht installiert – starte im Browser-Modus.');
    return runBrowser();
  }
  console.log('Starte Desktop-App (beim ersten Start wird Electron einmalig in den Projektordner geladen) …');
  const started = Date.now();
  const env = { ...process.env, ...localCacheEnv() };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [cli, ROOT], { cwd: ROOT, stdio: 'inherit', env });
  child.on('exit', (code) => {
    if (code && Date.now() - started < 20_000) {
      console.warn('\nDesktop-App konnte nicht gestartet werden – starte stattdessen im Browser-Modus.\n');
      return runBrowser();
    }
    process.exit(code ?? 0);
  });
}

if (desktop) runDesktop();
else runBrowser();
