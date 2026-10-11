import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Projektordner (enthält server/, web/, dist/ …). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_VERSION = '0.1.0';
/** Optionale lokale Konfigurationsdatei im Projektordner (z. B. abweichender Datenordner). */
export const LOCAL_CONFIG_FILE = path.join(PROJECT_ROOT, 'hotspot.config.json');

export interface AppConfig {
  dataDir: string;
  /** 0 = freier Port (Electron). Server bindet IMMER nur 127.0.0.1. */
  port: number;
  /** Zufälliges Zugriffstoken pro Prozessstart (UI bekommt es über index.html). */
  token: string;
  mockOllama: boolean;
  /** Zusätzlich erlaubte Origins (nur Dev: Vite-Server). */
  devOrigins: string[];
  /** Gebautes Web-UI; null = kein UI ausliefern (Tests / Dev). */
  webDir: string | null;
  /** Extraktion in Worker-Thread (Standard) – in Tests abschaltbar. */
  extractInWorker: boolean;
  logToFile: boolean;
  logLevel: string;
  /** Ollama-URL überschreiben (Tests). Sonst aus Settings. */
  ollamaUrlOverride?: string;
}

export function defaultDataDir(): string {
  if (process.platform === 'win32') {
    // Benutzerprofil (nicht "Dokumente": dort greift oft OneDrive-Sync -> SQLite-Risiko).
    const home = process.env.USERPROFILE || os.homedir();
    return path.join(home, 'Uni-Hotspot-Daten');
  }
  return path.join(PROJECT_ROOT, 'data');
}

interface LocalConfigFile {
  dataDir?: string;
}

export function readLocalConfig(): LocalConfigFile {
  try {
    const raw = fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as LocalConfigFile;
  } catch {
    /* Datei fehlt oder ist ungültig -> Defaults */
  }
  return {};
}

export function writeLocalConfig(cfg: LocalConfigFile): void {
  fs.writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function resolveDataDir(): string {
  const fromEnv = process.env.HOTSPOT_DATA_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const local = readLocalConfig().dataDir;
  if (local && typeof local === 'string' && path.isAbsolute(local)) return path.resolve(local);
  return defaultDataDir();
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const envPort = Number(process.env.HOTSPOT_PORT);
  const webDir = path.join(PROJECT_ROOT, 'dist', 'web');
  const devOrigins = (process.env.HOTSPOT_DEV_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(s));
  return {
    dataDir: resolveDataDir(),
    port: Number.isInteger(envPort) && envPort >= 0 && envPort < 65536 ? envPort : 4317,
    token: process.env.HOTSPOT_TOKEN && process.env.HOTSPOT_TOKEN.length >= 32
      ? process.env.HOTSPOT_TOKEN
      : crypto.randomBytes(32).toString('hex'),
    mockOllama: process.env.HOTSPOT_MOCK_OLLAMA === '1',
    devOrigins,
    webDir: fs.existsSync(path.join(webDir, 'index.html')) ? webDir : null,
    extractInWorker: true,
    logToFile: true,
    logLevel: process.env.HOTSPOT_LOG_LEVEL || 'info',
    ...overrides,
  };
}
