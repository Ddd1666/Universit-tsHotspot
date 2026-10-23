// Fake-ffmpeg (NUR Tests/Mock-Betrieb): ahmt die Teile von ffmpeg nach, die Uni-Hotspot nutzt.
// Die "Mediendatei" enthält nach einem echten Formatkopf einen Marker FAKEMEDIA{json}:
//   { duration: Sekunden|null, audio: bool, video: bool, drm?: bool, realDuration?: Sekunden, words?: string[], hangFile?: Pfad }
// Aufruf: node ffmpeg.mjs [--log <datei>] <echte ffmpeg-Argumente>
import fs from 'node:fs';

let args = process.argv.slice(2);
if (args[0] === '--log') {
  fs.appendFileSync(args[1], JSON.stringify({ tool: 'ffmpeg', args: args.slice(2) }) + '\n');
  args = args.slice(2);
}
const val = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const input = val('-i');
let spec = null;
try {
  const raw = fs.readFileSync(input).toString('latin1');
  const m = /FAKEMEDIA(\{[^\n]*\})/.exec(raw);
  if (m) spec = JSON.parse(m[1]);
} catch {
  /* nicht lesbar */
}
const clock = (s) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`;
};

const out = args[args.length - 1];
const isProbe = args.length >= 2 && args[args.length - 2] === '-i';
if (isProbe) {
  if (!spec) {
    process.stderr.write(`${input}: Invalid data found when processing input\n`);
    process.exit(1);
  }
  if (spec.drm) {
    process.stderr.write(`Input #0, mov,mp4,m4a, from '${input}':\n  Duration: ${clock(spec.duration ?? 60)}, bitrate: 128 kb/s\n  Stream #0:0[0x1](und): Audio: none (drms / 0x736D7264), 44100 Hz, 2 channels\n`);
    process.exit(1);
  }
  let s = `Input #0, fake, from '${input}':\n  Duration: ${spec.duration === null ? 'N/A' : clock(spec.duration)}, start: 0.000000, bitrate: 128 kb/s\n`;
  if (spec.video) s += '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1280x720, 25 fps\n';
  if (spec.audio) s += '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s\n';
  s += 'At least one output file must be specified\n';
  process.stderr.write(s);
  process.exit(1);
}

if (!spec) {
  process.stderr.write('Invalid data found when processing input\n');
  process.exit(1);
}

if (args.includes('-frames:v')) {
  // Keyframe: 1x1-PNG + Marker (wird vom Mock-Ollama als "OCR-Text" gelesen)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(out, Buffer.concat([png, Buffer.from(`MOCKTEXT:Folie bei ${val('-ss')} s`)]));
  process.exit(0);
}

// Segment als "WAV": JSON statt Audiodaten; leere Datei (44 Byte), wenn hinter dem Ende
const start = Number(val('-ss') ?? 0);
const length = Number(val('-t') ?? 600);
const real = spec.realDuration ?? spec.duration ?? 0;
if (start >= real) {
  fs.writeFileSync(out, Buffer.alloc(44));
  process.exit(0);
}
const body = JSON.stringify({ start, length, duration: real, words: spec.words ?? [], hangFile: spec.hangFile ?? null, hangFrom: spec.hangFrom ?? 0, grandchild: !!spec.grandchild, pidFile: spec.pidFile ?? null });
fs.writeFileSync(out, Buffer.concat([Buffer.from('RIFF....WAVE'), Buffer.from(body, 'latin1'), Buffer.alloc(2048, 32)]));
