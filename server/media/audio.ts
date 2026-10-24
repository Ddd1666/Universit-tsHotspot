import fsp from 'node:fs/promises';
import { codedError } from '../ingest/types.ts';
import { runTool, stderrExcerpt, type ToolCommand } from './proc.ts';

/** Transkript-Eintrag (Sekunden, absolut in der Aufnahme). */
export interface TranscriptEntry {
  s: number;
  e: number;
  t: string;
}

export interface ProbeResult {
  /** Sekunden; null = unbekannt (z. B. WebM ohne Dauer im Kopf) */
  duration: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface MediaTimeouts {
  probeMs: number;
  extractMs: number;
  /** pro Segment: max(whisperMinMs, whisperPerAudioSec × Segmentlänge) */
  whisperMinMs: number;
  whisperPerAudioSecMs: number;
}

// whisper: 4 s Rechenzeit je Audio-Sekunde (großzügig für medium auf CPU), mindestens 2 min (Modell laden)
export const DEFAULT_TIMEOUTS: MediaTimeouts = { probeMs: 60_000, extractMs: 180_000, whisperMinMs: 2 * 60_000, whisperPerAudioSecMs: 4000 };

/** Segmentlänge 10 min, Überlappung 5 s (Wörter an der Schnittkante gehen nicht verloren). */
export const SEGMENT_SEC = 600;
export const OVERLAP_SEC = 5;

/** `ffmpeg -i` (ohne Ausgabe) beendet sich mit Fehlercode, schreibt aber die Formatinfos nach stderr. */
export function parseProbe(stderr: string): ProbeResult {
  const streams = stderr.split('\n').filter((l) => /Stream #\d+:\d+/.test(l));
  const drm = /\b(drm|drms|enca|encv|cenc|encrypted|decryption)\b/i;
  if (!streams.length) {
    if (drm.test(stderr)) throw codedError('Medium ist verschlüsselt/DRM-geschützt', 'media_encrypted');
    throw codedError('Mediendatei beschädigt oder unbekannt', 'media_corrupt');
  }
  if (streams.some((l) => drm.test(l))) throw codedError('Medium ist verschlüsselt/DRM-geschützt', 'media_encrypted');
  const d = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  return {
    duration: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
    hasAudio: streams.some((l) => /: Audio:/.test(l)),
    hasVideo: streams.some((l) => /: Video:/.test(l) && !/attached pic|mjpeg|png/i.test(l)),
  };
}

export async function probe(ffmpeg: ToolCommand, file: string, opts: { timeouts: MediaTimeouts; signal?: AbortSignal }): Promise<ProbeResult> {
  const r = await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { timeoutMs: opts.timeouts.probeMs, signal: opts.signal });
  // ffmpeg ohne Ausgabedatei endet regulär mit Code 1 (auch bei defekter Datei). Anderer Code oder gar keine Ausgabe
  // = das Werkzeug selbst ist kaputt/blockiert (z. B. Smart App Control) – nicht die Datei des Nutzers.
  if ((r.code !== 0 && r.code !== 1) || !r.stderr.trim()) throw codedError(`ffmpeg-Prüfung fehlgeschlagen (Code ${r.code}): ${stderrExcerpt(r.stderr)}`, 'media_tool_failed');
  return parseProbe(r.stderr);
}

/**
 * Extraktionsfenster für Segment i: Kern [i·L, (i+1)·L) plus beidseitig `overlapSec`. Ein Satz über der Schnittkante
 * liegt so in BEIDEN Fenstern vollständig vor; `keepEntries` behält ihn nur in dem Segment, in dessen Kern seine Mitte liegt.
 */
export function segmentWindow(i: number, segSec = SEGMENT_SEC, overlapSec = OVERLAP_SEC): { start: number; length: number } {
  const start = Math.max(0, i * segSec - overlapSec);
  return { start, length: (i + 1) * segSec + overlapSec - start };
}

/** Zeitlimit für whisper.cpp aus der tatsächlich zu transkribierenden Dauer (letztes Segment ist meist kürzer). */
export function whisperTimeoutMs(win: { start: number; length: number }, duration: number | null, t: MediaTimeouts): number {
  const sec = duration === null ? win.length : Math.max(0, Math.min(win.length, duration - win.start));
  return Math.max(t.whisperMinMs, Math.ceil(t.whisperPerAudioSecMs * sec));
}

/**
 * Überlappung auflösen: ein Eintrag gehört zu dem Segment, in dessen Kernbereich [i·L, (i+1)·L) seine Mitte liegt.
 * So erscheint kein Satz doppelt und keiner fehlt (Einträge im Überlappungsbereich stammen aus dem Vorgänger).
 */
export function keepEntries(entries: TranscriptEntry[], i: number, isLast: boolean, segSec = SEGMENT_SEC): TranscriptEntry[] {
  const from = i * segSec;
  const to = (i + 1) * segSec;
  return entries.filter((x) => {
    const mid = (x.s + x.e) / 2;
    return mid >= from && (isLast || mid < to);
  });
}

/** 16-kHz-Mono-WAV eines Segments (Tonspur auch aus Videos). */
export async function extractSegment(
  ffmpeg: ToolCommand,
  file: string,
  out: string,
  win: { start: number; length: number },
  opts: { timeouts: MediaTimeouts; signal?: AbortSignal },
): Promise<number> {
  const r = await runTool(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(win.start), '-t', String(win.length), '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out],
    { timeoutMs: opts.timeouts.extractMs, signal: opts.signal },
  );
  if (r.code !== 0) {
    if (/encrypt|drm/i.test(r.stderr)) throw codedError('Medium ist verschlüsselt/DRM-geschützt', 'media_encrypted');
    throw codedError(`ffmpeg fehlgeschlagen (Code ${r.code}): ${stderrExcerpt(r.stderr)}`, 'media_tool_failed');
  }
  try {
    return (await fsp.stat(out)).size;
  } catch {
    return 0;
  }
}

/** whisper.cpp-JSON (`-oj`) -> Einträge, verschoben um den Segmentstart. Unbrauchbares wird verworfen. */
export function parseWhisperJson(raw: string, offsetSec: number): TranscriptEntry[] {
  let j: { transcription?: { offsets?: { from?: number; to?: number }; text?: string }[] };
  try {
    j = JSON.parse(raw) as typeof j;
  } catch {
    throw codedError('whisper lieferte keine gültige Ausgabe', 'media_tool_failed');
  }
  const out: TranscriptEntry[] = [];
  for (const x of Array.isArray(j.transcription) ? j.transcription : []) {
    const from = Number(x.offsets?.from);
    const to = Number(x.offsets?.to);
    // eslint-disable-next-line no-control-regex
    const t = String(x.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    if (!t || !Number.isFinite(from) || !Number.isFinite(to) || /^\[(BLANK_AUDIO|MUSIC|Musik|silence)\]$/i.test(t)) continue;
    out.push({ s: offsetSec + from / 1000, e: offsetSec + Math.max(from, to) / 1000, t: t.slice(0, 2000) });
  }
  return out;
}

export async function transcribeSegment(
  whisper: ToolCommand,
  model: string,
  wav: string,
  outBase: string,
  opts: { language: 'auto' | 'de' | 'en'; threads: number; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  const r = await runTool(whisper, ['-m', model, '-f', wav, '-l', opts.language, '-t', String(opts.threads), '-oj', '-of', outBase, '-np'], {
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (r.code !== 0) throw codedError(`whisper fehlgeschlagen (Code ${r.code}): ${stderrExcerpt(r.stderr)}`, 'media_tool_failed');
  try {
    return await fsp.readFile(`${outBase}.json`, 'utf8');
  } catch {
    throw codedError('whisper lieferte keine Ausgabedatei', 'media_tool_failed');
  }
}

/** Einzelbild an Zeitpunkt t (Keyframe für Vision), max. 1280 px breit. */
export async function extractFrame(ffmpeg: ToolCommand, file: string, out: string, t: number, opts: { timeouts: MediaTimeouts; signal?: AbortSignal }): Promise<boolean> {
  const r = await runTool(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", out],
    { timeoutMs: opts.timeouts.extractMs, signal: opts.signal },
  );
  if (r.code !== 0) return false;
  try {
    return (await fsp.stat(out)).size > 0;
  } catch {
    return false;
  }
}
