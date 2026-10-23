import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { codedError } from '../ingest/types.ts';

/** Werkzeug-Aufruf: Programm + feste Vor-Argumente (Tests: `node fake-ffmpeg.mjs`). Nie ein Shell-String. */
export interface ToolCommand {
  cmd: string;
  args: string[];
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 256 * 1024;

/**
 * Prozessbaum hart beenden. Windows: `taskkill /T /F` auf die EIGENE Kind-PID (kein Admin nötig, kein Musterabgleich);
 * POSIX: Signal an die eigene Prozessgruppe (Kind wurde mit detached gestartet).
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const k = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => child.kill());
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Startet ein Werkzeug mit festen Argumenten (kein Shell), begrenzt Laufzeit und Ausgabe, läuft mit niedriger
 * Prozesspriorität (Chat/UI bleiben flüssig) und beendet bei Abbruch/Timeout den gesamten Prozessbaum.
 */
export function runTool(tool: ToolCommand, args: string[], opts: { timeoutMs: number; signal?: AbortSignal; cwd?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(codedError('abgebrochen', 'media_cancelled'));
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(tool.cmd, [...tool.args, ...args], {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(codedError(`Werkzeug nicht startbar: ${(err as Error).message}`, 'media_tool_failed', err));
      return;
    }
    try {
      if (child.pid !== undefined) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      /* Priorität ist nur eine Optimierung */
    }
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    let reason: 'timeout' | 'abort' | null = null;
    let settled = false;
    let grace: NodeJS.Timeout | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = () => reject(reason === 'abort' ? codedError('abgebrochen', 'media_cancelled') : codedError('Zeitüberschreitung des Werkzeugs', 'media_timeout'));
    const stop = (r: 'timeout' | 'abort') => {
      reason ??= r;
      killTree(child);
      // Falls das Beenden hängt (z. B. taskkill blockiert): nicht ewig warten
      grace ??= setTimeout(() => settle(fail), 5000);
    };
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs);
    const onAbort = () => stop('abort');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => settle(() => reject(codedError(`Werkzeug nicht startbar: ${err.message}`, 'media_tool_failed', err))));
    child.on('close', (code) => settle(() => (reason ? fail() : resolve({ code, stdout, stderr }))));
  });
}
