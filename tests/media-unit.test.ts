import { describe, expect, it } from 'vitest';
import { keepEntries, parseProbe, parseWhisperJson, segmentWindow, SEGMENT_SEC } from '../server/media/audio.ts';
import { downscale, encodePng, imageSize } from '../server/media/image.ts';
import { parseVisionOutput } from '../server/media/vision.ts';
import { detectKind, sniffMedia } from '../server/ingest/detect.ts';
import { chunkBlocks, formatClock, locationLabel } from '../server/ingest/chunker.ts';
import { Scheduler } from '../server/scheduler.ts';
import { matchesPattern, validateManifest } from '../server/media/installer.ts';
import { makePng } from './fixtures.ts';

describe('Segmente mit Überlappung', () => {
  it('Fenster: 10 min, ab dem 2. Segment 5 s nach vorn überlappend', () => {
    expect(segmentWindow(0)).toEqual({ start: 0, length: 600 });
    expect(segmentWindow(1)).toEqual({ start: 595, length: 605 });
    expect(segmentWindow(17)).toEqual({ start: 17 * 600 - 5, length: 605 });
  });

  it('jeder Satz landet in genau einem Segment (Mitte entscheidet), keiner fehlt', () => {
    // Sätze alle 3 s über 25 min, jeweils 4 s lang
    const sentences = Array.from({ length: 500 }, (_, i) => ({ s: i * 3, e: i * 3 + 4, t: `S${i}` }));
    const kept: string[] = [];
    for (let i = 0; i * SEGMENT_SEC < 1500; i++) {
      const w = segmentWindow(i);
      const inWindow = sentences.filter((x) => x.s >= w.start && x.e <= w.start + w.length);
      kept.push(...keepEntries(inWindow, i, (i + 1) * SEGMENT_SEC >= 1500).map((x) => x.t));
    }
    const expected = sentences.filter((x) => x.e <= 1500 || x.s < 1500).map((x) => x.t);
    expect(new Set(kept).size).toBe(kept.length); // keine Dubletten
    expect(kept.filter((k) => expected.includes(k)).length).toBeGreaterThanOrEqual(expected.length - 2); // höchstens Randsätze am Dateiende
  });
});

describe('ffmpeg-Ausgabe auswerten', () => {
  it('Dauer, Tonspur, Video (Cover-Bild zählt nicht als Video)', () => {
    const r = parseProbe(`Input #0, mp3, from 'a.mp3':\n  Duration: 01:30:05.50, start: 0\n  Stream #0:0: Audio: mp3, 44100 Hz\n  Stream #0:1: Video: mjpeg (Baseline), 600x600 (attached pic)\n`);
    expect(r).toEqual({ duration: 5405.5, hasAudio: true, hasVideo: false });
    expect(parseProbe('  Duration: N/A, bitrate: N/A\n  Stream #0:0: Audio: opus\n').duration).toBeNull();
  });

  it('defekt / verschlüsselt -> Fehlercodes', () => {
    expect(() => parseProbe('x.mp3: Invalid data found when processing input\n')).toThrow(expect.objectContaining({ code: 'media_corrupt' }));
    expect(() => parseProbe('')).toThrow(expect.objectContaining({ code: 'media_corrupt' }));
    expect(() => parseProbe('  Duration: 00:03:00.00\n  Stream #0:0(und): Audio: none (drms / 0x736D7264)\n')).toThrow(expect.objectContaining({ code: 'media_encrypted' }));
  });

  it('pathologische ffmpeg-Ausgabe (1 MB Müll) wird linear und schnell verarbeitet', () => {
    const junk = 'Stream #'.repeat(1000) + 'D'.repeat(1_000_000) + '\n  Stream #0:0: Audio: aac\n';
    const t0 = performance.now();
    expect(parseProbe(junk).hasAudio).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000); // grosszügig: nur gegen katastrophales Backtracking
  });
});

describe('whisper.cpp-JSON', () => {
  it('verschiebt um den Segmentstart, filtert Leeres und Steuerzeichen', () => {
    const raw = JSON.stringify({
      transcription: [
        { offsets: { from: 1000, to: 3000 }, text: ' Hallo\u0007 Welt ' },
        { offsets: { from: 3000, to: 4000 }, text: '[BLANK_AUDIO]' },
        { offsets: { from: 'x', to: 1 }, text: 'kaputt' },
        { text: 'ohne Zeit' },
      ],
    });
    expect(parseWhisperJson(raw, 600)).toEqual([{ s: 601, e: 603, t: 'Hallo Welt' }]);
  });

  it('kein JSON -> Fehlercode; riesige Ausgabe wird begrenzt', () => {
    expect(() => parseWhisperJson('kein json', 0)).toThrow(expect.objectContaining({ code: 'media_tool_failed' }));
    const big = JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1 }, text: 'a'.repeat(100_000) }] });
    expect(parseWhisperJson(big, 0)[0]!.t).toHaveLength(2000);
  });
});

describe('Bilder ohne native Module', () => {
  it('Abmessungen aus PNG/GIF/BMP/WebP/JPEG-Kopf', () => {
    expect(imageSize(makePng(31, 17))).toEqual({ width: 31, height: 17 });
    const gif = Buffer.from('GIF89a\x20\x00\x10\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 32, height: 16 });
    const bmp = Buffer.alloc(30);
    bmp.write('BM');
    bmp.writeInt32LE(40, 18);
    bmp.writeInt32LE(-20, 22);
    expect(imageSize(bmp)).toEqual({ width: 40, height: 20 });
    // JPEG: SOI, APP0 (Länge 16), SOF0 mit 100x50
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 50, 0, 100, 3]), Buffer.alloc(16)]);
    expect(imageSize(jpg)).toEqual({ width: 100, height: 50 });
    expect(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).toBeNull();
  });

  it('präparierter JPEG-Kopf (Segmentlänge 0 / Endlosschleife) terminiert', () => {
    const evil = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xe1, 0, 0]).subarray(0, 4), Buffer.alloc(100, 0xff)]);
    expect(imageSize(evil)).toBeNull();
  });

  it('Verkleinern + PNG-Kodierung ergeben ein gültiges PNG', () => {
    const w = 400;
    const h = 300;
    const px = new Uint8Array(w * h * 3).fill(200);
    const small = downscale(px, w, h, 3, 100);
    expect([small.width, small.height]).toEqual([100, 75]);
    const png = encodePng(small.data, small.width, small.height, 3);
    expect(imageSize(png)).toEqual({ width: 100, height: 75 });
  });
});

describe('Sniffing (Endung ≠ Inhalt)', () => {
  it('erkennt Medien am Inhalt und lehnt getarnte Dateien ab', () => {
    expect(sniffMedia(Buffer.from('ID3\x03\0\0', 'latin1'))).toEqual({ kind: 'audio', mime: 'audio/mpeg' });
    expect(sniffMedia(Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'))!.mime).toBe('audio/wav');
    expect(sniffMedia(Buffer.from('\0\0\0\x18ftypM4A \0\0', 'latin1'))!.mime).toBe('audio/mp4');
    expect(sniffMedia(Buffer.from('\0\0\0\x18ftypisom\0\0', 'latin1'), 'mp4')!.mime).toBe('video/mp4');
    expect(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))!.mime).toBe('video/webm');
    expect(detectKind('lied.mp3', Buffer.from('<html><script>x</script>'))).toMatchObject({ kind: 'other', reason: 'media_mismatch' });
    expect(detectKind('bild.jpg', Buffer.from('MZ\x90\0', 'latin1'))).toMatchObject({ kind: 'other', reason: 'media_mismatch' });
    // UTF-16-Text mit BOM FF FE ist kein MP3-Frame
    expect(detectKind('notiz.txt', Buffer.from([0xff, 0xfe, 0x41, 0])).kind).toBe('text');
    // PNG mit .mp3-Endung: Inhalt gewinnt
    expect(detectKind('trick.mp3', makePng(2, 2)).kind).toBe('image');
  });
});

describe('Vision-Ausgabe validieren', () => {
  it('nur gültiges JSON mit beiden Feldern; Längen begrenzt; Steuerzeichen raus', () => {
    expect(parseVisionOutput(JSON.stringify({ text: 'a\u0001b', description: 'd' }))).toEqual({ text: 'ab', description: 'd' });
    expect(parseVisionOutput('```json\n{"text":"","description":"x"}\n```')).toEqual({ text: '', description: 'x' });
    expect(parseVisionOutput('{"text":1,"description":"x"}')).toBeNull();
    expect(parseVisionOutput('nope')).toBeNull();
    expect(parseVisionOutput(JSON.stringify({ text: 'x'.repeat(50_000), description: '' }))!.text).toHaveLength(20_000);
  });
});

describe('Zeit-Chunks', () => {
  it('mm:ss–mm:ss im Prompt, h:mm:ss ab einer Stunde', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(locationLabel({ locKind: 'time', locStart: 65, locEnd: 130, locLabel: null })).toBe('time 01:05-02:10');
  });

  it('Transkript-Blöcke werden zu Abschnitten mit Zeitbereich; nie mit Dateitext gemischt', () => {
    const blocks = Array.from({ length: 200 }, (_, i) => ({ text: `Satz Nummer ${i} über Thermodynamik und Entropie.`, loc: { kind: 'time' as const, index: i * 10, end: i * 10 + 8 }, origin: 'transcript' as const }));
    const cs = chunkBlocks(blocks);
    expect(cs.length).toBeGreaterThan(1);
    expect(cs.every((c) => c.origin === 'transcript' && c.locKind === 'time' && c.locStart! <= c.locEnd!)).toBe(true);
    expect(cs[0]!.locStart).toBe(0);
    // dünnes Transkript (ein Satz alle 30 s): Abschnitte trotzdem höchstens ~2 min lang (präzise Sprünge im Player)
    const sparse = chunkBlocks(Array.from({ length: 50 }, (_, i) => ({ text: `Satz ${i}.`, loc: { kind: 'time' as const, index: i * 30, end: i * 30 + 4 }, origin: 'transcript' as const })));
    expect(sparse.length).toBeGreaterThan(5);
    for (const c of sparse) expect(c.locEnd! - c.locStart!).toBeLessThanOrEqual(124);
    const mixed = chunkBlocks([
      { text: 'Text aus der Datei', loc: { kind: 'page', index: 1 } },
      { text: 'OCR-Text', loc: { kind: 'page', index: 1 }, origin: 'ocr' },
    ]);
    expect(mixed.map((c) => c.origin ?? null)).toEqual([null, 'ocr']);
  });
});

describe('Scheduler: Chat > Embedding > Medien, seriell', () => {
  it('vergibt den Slot nach Priorität und nie an zwei gleichzeitig', async () => {
    const s = new Scheduler();
    const order: string[] = [];
    const first = await s.acquire('media');
    const p1 = s.acquire('media').then((r) => (order.push('media2'), r));
    const p2 = s.acquire('embed').then((r) => (order.push('embed'), r));
    expect(s.snapshot()).toMatchObject({ holder: 'media', waiting: { embed: 1, media: 1 } });
    first();
    const r2 = await p2;
    expect(order).toEqual(['embed']);
    r2();
    (await p1)();
    expect(order).toEqual(['embed', 'media2']);
  });

  it('während ein Chat streamt, bekommt niemand einen Slot; danach sofort', async () => {
    const s = new Scheduler();
    const end = s.chatStarted();
    let got = false;
    const p = s.acquire('embed').then((r) => {
      got = true;
      return r;
    });
    const idle = s.whenNoChat();
    await Promise.resolve();
    expect(got).toBe(false);
    expect(s.snapshot().chatActive).toBe(true);
    end();
    end(); // doppelt beenden ist harmlos
    (await p)();
    await idle;
    expect(got).toBe(true);
    expect(s.snapshot()).toEqual({ chatActive: false, holder: null, waiting: { embed: 0, media: 0 } });
  });

  it('Abbruch eines Wartenden entfernt ihn aus der Schlange', async () => {
    const s = new Scheduler();
    const r = await s.acquire('media');
    const ctrl = new AbortController();
    const p = s.acquire('media', ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    r();
    expect(s.snapshot().waiting.media).toBe(0);
  });
});

describe('Manifest-Prüfung', () => {
  const item = { id: 'x', label: 'X', url: 'https://example.org/x.zip', sha256: 'a'.repeat(64), size: 10, type: 'zip', target: 'x', check: 'x/x.exe' };
  it('akzeptiert nur https, feste Hashes und relative Ziele in tools/', () => {
    expect(validateManifest({ version: 1, platform: 'win32-x64', items: [item] }).items).toHaveLength(1);
    for (const bad of [{ url: 'http://example.org/x' }, { url: 'file:///etc/passwd' }, { sha256: 'abc' }, { target: '../outside' }, { target: 'C:/Windows' }, { check: '/abs' }, { size: -1 }, { id: '../x' }]) {
      expect(() => validateManifest({ version: 1, platform: 'win32-x64', items: [{ ...item, ...bad }] }), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'download_manifest' }));
    }
    expect(() => validateManifest({ version: 1, platform: 'x', items: [{ ...item, url: 'http://127.0.0.1:9/x' }] })).toThrow();
    expect(validateManifest({ version: 1, platform: 'x', items: [{ ...item, url: 'http://127.0.0.1:9/x' }] }, { allowLocalHttp: true }).items).toHaveLength(1);
  });

  it('Auswahl der Archiv-Einträge', () => {
    expect(matchesPattern('ffmpeg-9/bin/ffmpeg.exe', ['bin/ffmpeg.exe'])).toBe(true);
    expect(matchesPattern('ffmpeg-9/doc/bin/ffmpeg.exe.txt', ['bin/ffmpeg.exe'])).toBe(false);
    expect(matchesPattern('Release/whisper-cli.exe', ['*.exe', '*.dll'])).toBe(true);
    expect(matchesPattern('Release/readme.txt', ['*.exe', '*.dll'])).toBe(false);
  });
});

describe('Neue SQL-Abfragen nutzen Indizes (EXPLAIN QUERY PLAN)', () => {
  it('Job-Queue, Zwischenstände und KI-Abschnitte ohne Tabellen-Scan/Sortierung', async () => {
    const { openDb } = await import('../server/db.ts');
    const db = openDb(':memory:');
    const plan = (sql: string) => (db.prepare('EXPLAIN QUERY PLAN ' + sql).all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    const checks: [string, RegExp][] = [
      [`SELECT id FROM media_jobs WHERE state = 'queued' AND kind IN (SELECT value FROM json_each('["image"]')) ORDER BY id LIMIT 1`, /USING INDEX media_jobs_state/],
      [`SELECT state, count(*) AS n FROM media_jobs WHERE state IN ('queued', 'running', 'error') GROUP BY state`, /COVERING INDEX media_jobs_state/],
      [`SELECT idx, data FROM media_parts WHERE job_id = 1 ORDER BY idx`, /PRIMARY KEY \(job_id=\?\)/],
      [`SELECT id, state, params FROM media_jobs WHERE source_id = 1 ORDER BY id DESC LIMIT 1`, /INDEX media_jobs_source/],
      [`SELECT id, ord, loc_start FROM chunks WHERE source_id = 1 ORDER BY ord`, /INDEX chunks_source /],
    ];
    for (const [sql, re] of checks) {
      const p = plan(sql);
      expect(p, sql).toMatch(re);
      expect(p, sql).not.toMatch(/TEMP B-TREE|SCAN (media_jobs|media_parts|chunks)\b/);
    }
    db.close();
  });
});
