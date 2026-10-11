/**
 * Extractor-Plugin-Schnittstelle.
 * Phase 2 (OCR/Vision, Audio/Video via whisper.cpp) ergänzt nur neue Extractor-Implementierungen
 * in extractors/registry.ts – Pipeline, Chunking und Index bleiben unverändert.
 */

export type SourceKind =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'odt'
  | 'odp'
  | 'ods'
  | 'csv'
  | 'html'
  | 'markdown'
  | 'text'
  | 'code'
  | 'json'
  | 'zip'
  | 'image'
  | 'audio'
  | 'video'
  | 'legacy-office'
  | 'encrypted-office'
  | 'other';

export type LocKind = 'page' | 'slide' | 'sheet' | 'rows' | 'lines' | 'section';

export interface BlockLocation {
  kind: LocKind;
  /** Seite / Folie / Startzeile / Blatt-Nr. (1-basiert) */
  index?: number;
  /** Endzeile o. Ä. (inklusive) */
  end?: number;
  /** z. B. Tabellenblatt-Name */
  label?: string;
}

export interface TextBlock {
  text: string;
  loc?: BlockLocation;
  /** nächstliegende Überschrift (Abschnitt / Folientitel) */
  heading?: string;
  role?: 'heading' | 'body' | 'notes' | 'table';
}

export interface ExtractResult {
  blocks: TextBlock[];
  meta?: { pages?: number; title?: string };
  warnings?: string[];
}

export interface ExtractInput {
  path: string;
  name: string;
  ext: string;
  mime: string;
  kind: SourceKind;
}

export interface ExtractLimits {
  /** max. entpackte Bytes je OOXML-Teil (Zip-Bomb-Schutz in DOCX/PPTX/XLSX) */
  maxPartBytes: number;
  /** max. Zellen je Arbeitsmappe */
  maxCells: number;
  /** Text-/CSV-/HTML-Dateien: nur so viele Bytes indexieren (Datei bleibt vollständig gespeichert) */
  maxTextBytes: number;
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxPartBytes: 256 * 1024 * 1024,
  maxCells: 300_000,
  maxTextBytes: 32 * 1024 * 1024,
};

export interface Extractor {
  id: string;
  canHandle(input: Pick<ExtractInput, 'kind' | 'ext' | 'mime'>): boolean;
  extract(input: ExtractInput, limits: ExtractLimits): Promise<ExtractResult>;
}

/** Gespeicherter Chunk (Ergebnis des Chunkers). */
export interface ChunkDraft {
  text: string;
  heading: string | null;
  locKind: LocKind | null;
  locStart: number | null;
  locEnd: number | null;
  locLabel: string | null;
  tokenEst: number;
}

/**
 * Fehler mit stabilem Code (z. B. 'office_corrupt'): wird als Statusdetail gespeichert und in der Oberfläche
 * übersetzt (`detail.<code>`); die deutsche Meldung landet nur im Log.
 */
export function codedError(message: string, code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

