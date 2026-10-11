import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../server/config.ts';

/** Test-Temp (.tmp/tests/p<pid>/…) vor und nach dem Lauf leeren, damit sich nichts ansammelt. */
const dir = path.join(PROJECT_ROOT, '.tmp', 'tests');
const clean = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });

export default function setup(): () => void {
  clean();
  return clean;
}
