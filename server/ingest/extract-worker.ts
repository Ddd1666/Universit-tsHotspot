import { parentPort } from 'node:worker_threads';
import { runExtraction } from './extract-run.ts';
import type { ExtractInput, ExtractLimits } from './types.ts';

interface Job {
  id: number;
  input: ExtractInput;
  limits: ExtractLimits;
}

parentPort?.on('message', (job: Job) => {
  runExtraction(job.input, job.limits).then(
    (result) => parentPort!.postMessage({ id: job.id, ok: true, result }),
    (err: unknown) =>
      parentPort!.postMessage({
        id: job.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: unknown })?.code,
      }),
  );
});
