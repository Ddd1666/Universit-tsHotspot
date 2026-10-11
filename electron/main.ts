/**
 * Electron-Hülle: startet den lokalen Server im selben Prozess (Port zufällig, nur 127.0.0.1)
 * und zeigt die Oberfläche in einem abgesicherten Fenster.
 * Sicherheit: contextIsolation, kein nodeIntegration, Sandbox, keine fremden Seiten/Navigation,
 * keine Berechtigungen (Kamera, Mikrofon …), CSP kommt vom Server.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, session, shell, type WebContents } from 'electron';
import { loadConfig, resolveDataDir } from '../server/config.ts';
import { createHotspot, type Hotspot } from '../server/app.ts';
import { AlreadyRunningError } from '../server/lock.ts';
import { DIALOG_TEXT, dialogLanguage } from './messages.ts';

// Chromium-Profil (Cache, LocalStorage) & Logs in den Datenordner statt nach %APPDATA% – nichts außerhalb schreiben.
const profileDir = path.join(resolveDataDir(), 'electron-profile');
app.setPath('userData', profileDir);
app.setPath('sessionData', profileDir);
app.setPath('crashDumps', path.join(profileDir, 'crashes'));
app.setAppLogsPath(path.join(resolveDataDir(), 'logs'));

let hotspot: Hotspot | null = null;
/** Dialogtexte in der Oberflächensprache (Einstellung) bzw. OS-Sprache – erst bei Bedarf ermittelt */
const texts = () => DIALOG_TEXT[dialogLanguage(resolveDataDir(), app.getLocale())];
let win: BrowserWindow | null = null;
let origin = '';

/** Links aus der App: eigene Datei-Downloads und http(s)-Links im Standardbrowser öffnen – sonst nichts. */
function openExternalSafe(url: string): void {
  try {
    const u = new URL(url);
    const own = u.origin === origin;
    if (own && u.pathname.startsWith('/api/sources/')) void shell.openExternal(url);
    else if (!own && (u.protocol === 'https:' || u.protocol === 'http:')) void shell.openExternal(url);
  } catch {
    /* ungültige URL ignorieren */
  }
}

function harden(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (!origin || !url.startsWith(origin + '/')) e.preventDefault();
  });
  contents.on('will-attach-webview', (e) => e.preventDefault());
}

async function boot(): Promise<void> {
  // Keine Wörterbuch-Downloads aus dem Internet (Chromium lädt sonst Rechtschreib-Wörterbücher nach)
  session.defaultSession.setSpellCheckerEnabled(false);
  session.defaultSession.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
  const config = loadConfig({ port: 0, token: crypto.randomBytes(32).toString('hex') });
  if (!config.webDir) {
    dialog.showErrorBox('Uni-Hotspot', texts().notBuilt);
    app.quit();
    return;
  }
  try {
    hotspot = await createHotspot(config);
    origin = (await hotspot.listen()).url;
  } catch (err) {
    if (err instanceof AlreadyRunningError) {
      // z. B. Browser-Modus läuft schon mit demselben Datenordner: nichts anfassen, nur hinweisen
      const url = err.port ? `http://127.0.0.1:${err.port}` : null;
      const tx = texts();
      const r = await dialog.showMessageBox({
        type: 'info',
        title: 'Uni-Hotspot',
        message: tx.alreadyRunning,
        detail: [url ? tx.reachableAt(url) : '', tx.staleLockHint(err.lockFile)].filter(Boolean).join('\n\n'),
        buttons: url ? [tx.openInBrowser, tx.close] : [tx.close],
      });
      if (url && r.response === 0) await shell.openExternal(url);
    } else {
      dialog.showErrorBox(texts().startErrorTitle, (err as Error).message);
    }
    await hotspot?.close();
    hotspot = null;
    app.quit();
    return;
  }

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // Die Oberfläche darf ausschließlich den lokalen Server ansprechen (z. B. keine externen Bilder aus Modellantworten)
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, cb) => {
    cb({ cancel: !details.url.startsWith(origin + '/') });
  });
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 380,
    minHeight: 520,
    title: 'Uni-Hotspot',
    backgroundColor: '#05070f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));
  await win.loadURL(origin + '/');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('web-contents-created', (_e, contents) => harden(contents));
  app.whenReady().then(boot, (err: Error) => {
    dialog.showErrorBox('Uni-Hotspot', err.message);
    app.quit();
  });
  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting || !hotspot) return;
    e.preventDefault();
    quitting = true;
    void hotspot.close().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
