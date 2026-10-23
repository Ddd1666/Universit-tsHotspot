// Fake-whisper-cli (NUR Tests/Mock-Betrieb): liest das "WAV" des Fake-ffmpeg und schreibt whisper.cpp-JSON (-oj -of <base>).
// Alle 30 s ein Satz "Satz bei mm:ss" (+ Stichwort aus words). Steuerung über das Segment:
//   hangFile: existiert die Datei, hängt der Prozess (optional mit Enkelprozess, PIDs in pidFile) – für Abbruch-/Neustart-Tests.
// Aufruf: node whisper-cli.mjs [--log <datei>] <echte whisper-cli-Argumente>
import fs from 'node:fs';
import { spawn } from 'node:child_process';

let args = process.argv.slice(2);
if (args[0] === '--log') {
  fs.appendFileSync(args[1], JSON.stringify({ tool: 'whisper', args: args.slice(2) }) + '\n');
  args = args.slice(2);
}
const val = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const raw = fs.readFileSync(val('-f')).toString('latin1');
const seg = JSON.parse(raw.slice(12).trimEnd()); // "RIFF....WAVE" + JSON + Leerzeichen

if (seg.hangFile && fs.existsSync(seg.hangFile) && seg.start >= (seg.hangFrom ?? 0)) {
  const pids = [process.pid];
  if (seg.grandchild) {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    pids.push(c.pid);
  }
  if (seg.pidFile) fs.writeFileSync(seg.pidFile, JSON.stringify(pids));
  setInterval(() => {}, 1000);
} else {
  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const transcription = [];
  const end = Math.min(seg.start + seg.length, seg.duration);
  let k = 0;
  for (let t = Math.ceil(seg.start / 30) * 30; t < end; t += 30, k++) {
    const word = seg.words.length ? ` ${seg.words[Math.floor(t / 30) % seg.words.length]}` : '';
    const from = Math.round((t - seg.start) * 1000);
    transcription.push({ offsets: { from, to: from + 4000 }, text: ` Satz bei ${fmt(t)}${word}.` });
  }
  fs.writeFileSync(`${val('-of')}.json`, JSON.stringify({ result: { language: val('-l') }, transcription }));
}
