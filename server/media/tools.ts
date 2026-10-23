import fs from 'node:fs';
import path from 'node:path';
import type { ToolCommand } from './proc.ts';

/**
 * Externe Medien-Werkzeuge (whisper.cpp, ffmpeg) + Whisper-Modelle liegen im Projektordner unter `tools/`
 * (gitignored, reversibel: Ordner löschen). Begründung: Programmteile, jederzeit neu ladbar – sie gehören nicht in
 * den Datenordner, dessen Backup (= Ordner kopieren) sonst um ~0,6–1,7 GB wächst.
 */
export interface ToolOverrides {
  /** Befehls-Präfix statt der Binaries (nur Mock-/Testbetrieb), z. B. ["node", "tests/fake-tools/ffmpeg.mjs"] */
  ffmpeg?: string[];
  whisper?: string[];
  modelsDir?: string;
}

export interface MediaTools {
  ffmpeg: ToolCommand | null;
  whisper: ToolCommand | null;
  /** installierte Whisper-Modelle: Name ("small") -> Datei */
  models: Record<string, string>;
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
export const MODEL_RE = /^ggml-([a-z0-9._-]{1,40})\.bin$/;

function fromPrefix(prefix: string[] | undefined): ToolCommand | null {
  return prefix && prefix.length ? { cmd: prefix[0]!, args: prefix.slice(1) } : null;
}

export function resolveTools(toolsDir: string, overrides: ToolOverrides = {}): MediaTools {
  const file = (rel: string) => {
    const p = path.join(toolsDir, rel);
    return fs.existsSync(p) ? p : null;
  };
  const ffmpeg = fromPrefix(overrides.ffmpeg) ?? (file(path.join('ffmpeg', exe('ffmpeg'))) ? { cmd: path.join(toolsDir, 'ffmpeg', exe('ffmpeg')), args: [] } : null);
  const whisper =
    fromPrefix(overrides.whisper) ?? (file(path.join('whisper', exe('whisper-cli'))) ? { cmd: path.join(toolsDir, 'whisper', exe('whisper-cli')), args: [] } : null);
  const modelsDir = overrides.modelsDir ?? path.join(toolsDir, 'models');
  const models: Record<string, string> = {};
  try {
    for (const f of fs.readdirSync(modelsDir)) {
      const m = MODEL_RE.exec(f);
      if (m && fs.statSync(path.join(modelsDir, f)).size > 0) models[m[1]!] = path.join(modelsDir, f);
    }
  } catch {
    /* Ordner fehlt */
  }
  return { ffmpeg, whisper, models };
}
