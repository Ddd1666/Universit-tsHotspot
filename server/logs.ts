import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Log-Datei mit Rotation: ab `maxBytes` wird server.log -> server.log.1 -> … -> server.log.<keep> verschoben
 * (beim Start UND im laufenden Betrieb). Synchrones Schreiben (pino-Ziel): nach einem Absturz fehlt keine Zeile.
 */
export class RotatingLog {
  private fd: number | null = null;
  private size = 0;
  /** nächste Rotation ab dieser Größe (nach einem gescheiterten Versuch: erst nach weiteren maxBytes) */
  private threshold: number;
  readonly file: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(file: string, opts: { maxBytes?: number; keep?: number } = {}) {
    this.file = file;
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.threshold = this.maxBytes;
    this.keep = opts.keep ?? 3;
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
    if (this.size > this.threshold) this.rotate();
    this.open();
  }

  private open(): void {
    this.fd = fs.openSync(this.file, 'a');
    try {
      this.size = fs.fstatSync(this.fd).size;
    } catch {
      /* Größe bleibt geschätzt */
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    // Erst die aktuelle Datei beiseite: klappt das nicht (gesperrt), wird nichts gelöscht oder verschoben – die Historie
    // bleibt, es wird in dieselbe Datei weitergeschrieben und erst nach weiteren maxBytes erneut versucht (nicht je Zeile).
    const aside = `${this.file}.rotating`;
    try {
      if (fs.existsSync(this.file)) fs.renameSync(this.file, aside);
    } catch {
      this.threshold = this.size + this.maxBytes;
      return;
    }
    this.threshold = this.maxBytes;
    try {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      if (fs.existsSync(aside)) fs.renameSync(aside, `${this.file}.1`);
    } catch {
      /* einzelne ältere Datei gesperrt -> Rest bleibt unter .rotating erhalten */
    }
    this.size = 0;
  }

  write(chunk: string): boolean {
    if (this.fd === null) return false;
    try {
      this.size += fs.writeSync(this.fd, chunk);
      if (this.size > this.threshold) {
        this.rotate();
        this.open();
      }
    } catch {
      /* Logging darf die App nie stören */
    }
    return true;
  }

  end(cb?: () => void): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignorieren */
      }
      this.fd = null;
    }
    cb?.();
  }
}

/** Benutzerpfade (Benutzername) und Sitzungstoken unkenntlich machen. */
/** Benutzername(n) des Rechners (Kontoname, Name des Profilordners) – ab 3 Zeichen, sonst wäre Ersetzen zu grob. */
function userNames(): string[] {
  const names = new Set<string>();
  try {
    names.add(os.userInfo().username);
  } catch {
    /* kein Konto ermittelbar */
  }
  names.add(path.basename(os.homedir()));
  if (process.env.USERNAME) names.add(process.env.USERNAME);
  return [...names].filter((n) => n && n.length >= 3).sort((a, b) => b.length - a.length);
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactText(s: string): string {
  const home = os.homedir();
  let out = s;
  if (home && home.length > 3) out = out.split(home).join('<HOME>').split(home.replace(/\\/g, '/')).join('<HOME>');
  out = out
    // Benutzernamen dürfen Leerzeichen enthalten -> bis zum nächsten Pfadtrenner
    .replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/"'\r\n]+/gi, '$1<USER>')
    .replace(/(\/home\/|\/Users\/)[^/"'\r\n]+/g, '$1<USER>')
    .replace(/\b[0-9a-f]{64}\b/gi, '<HASH>')
    .replace(/([?&]t=)[^&\s"]+/g, '$1<TOKEN>');
  // jeder weitere Treffer des Benutzernamens (z. B. D:\parsi-daten, OneDrive-Ordner), ohne Groß/Klein
  for (const n of userNames()) out = out.replace(new RegExp(escapeRe(n), 'gi'), '<USER>');
  return out;
}

/**
 * Meldung für den Export: nur der feste Teil vor einem „:“ (danach stehen in alten Versionen 0.1–0.3 Dateinamen, z. B.
 * „Verarbeitung fehlgeschlagen: Skript.pdf“); erlaubt bleibt nur „Quelle #<id>“ als Rest.
 */
function safeMsg(msg: string): string {
  const i = msg.indexOf(':');
  if (i === -1) return msg;
  const head = msg.slice(0, i);
  const rest = msg.slice(i + 1).trim();
  return /^Quelle #\d+$/.test(rest) ? `${head}: ${rest}` : `${head}: …`;
}

/**
 * Log für den Diagnose-Export: nur Zeit, Stufe, Meldung (gekürzt, Text in Anführungszeichen entfernt) und bei Fehlern
 * Typ/Code + Stack-Zeilen. Zusatzdaten (`extra`, Fehlermeldungen, Anfragedaten) werden verworfen – darin könnten Dateinamen
 * oder Text aus Dokumenten/Modellantworten stehen.
 */
export function sanitizeLogLines(raw: string, maxLines = 2000): string[] {
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  const out: string[] = [];
  for (const line of lines) {
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // keine JSON-Zeile (fremd) -> weglassen
    }
    const time = typeof j.time === 'number' ? new Date(j.time).toISOString() : '?';
    const level = typeof j.level === 'number' ? ({ 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' } as Record<number, string>)[j.level] ?? String(j.level) : '?';
    const err = j.err as { type?: unknown; code?: unknown; stack?: unknown } | undefined;
    const hasErr = !!err && typeof err === 'object';
    // bei Fehlern ist msg = Fehlermeldung (pino) -> weglassen, nur Typ/Code/Stack
    const msg = hasErr
      ? ''
      : redactText(safeMsg(String(j.msg ?? '')))
          .replace(/"[^"]*"|„[^“]*“|'[^']*'/g, '"…"')
          .slice(0, 200);
    let row = `${time} ${level.padEnd(5)} ${msg}`;
    if (err && hasErr) {
      const frames = typeof err.stack === 'string' ? err.stack.split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 8).map((l) => redactText(l.trim())) : [];
      row += ` [${typeof err.type === 'string' ? err.type.slice(0, 40) : 'Error'}${typeof err.code === 'string' && /^[\w-]{1,40}$/.test(err.code) ? ` ${err.code}` : ''}]`;
      if (frames.length) row += '\n    ' + frames.join('\n    ');
    }
    out.push(row);
  }
  return out;
}
